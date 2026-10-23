/**
 * Installed-artifact contract for the Workflow journal storage patch, run against a copy of the
 * installed world-postgres package in a temporary directory: the shared node_modules is never
 * written. The replace helper mirrors `replaceExact` of scripts/apply-eve-patches.ts (count-checked,
 * an already patched artifact is accepted unchanged), so the second run must leave every file
 * byte for byte as the first did.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PAYLOAD_BLOBS_MIGRATION_TAG, patchWorkflowJournalStorage } from "../eve-patches/workflow-journal-storage.ts";

const execFileAsync = promisify(execFile);
const INSTALLED = resolve("node_modules/@workflow/world-postgres");

const count = (source: string, marker: string) => source.split(marker).length - 1;

async function replaceExact(path: string, before: string, after: string): Promise<void> {
  const source = await readFile(path, "utf8");
  const beforeCount = count(source, before);
  const afterCount = count(source, after);
  const unpatched = beforeCount - afterCount * count(after, before);
  if (unpatched === 0 && afterCount === 1) return;
  if (unpatched !== 1 || afterCount !== 0) {
    throw new Error(`PATCH_MISMATCH ${path}: before=${beforeCount}, after=${afterCount}`);
  }
  await writeFile(path, source.split(before).join(after), "utf8");
}

let world = "";
const files = () => ({
  storage: `${world}/dist/storage.js`,
  types: `${world}/dist/storage.d.ts`,
  runtime: `${world}/dist/osinara-payload-blobs.js`,
  journal: `${world}/src/drizzle/migrations/meta/_journal.json`,
  migration: `${world}/src/drizzle/migrations/${PAYLOAD_BLOBS_MIGRATION_TAG}.sql`,
});

beforeAll(async () => {
  world = await mkdtemp(resolve(tmpdir(), "osinara-world-postgres-"));
  await mkdir(`${world}/dist`, { recursive: true });
  await mkdir(`${world}/src/drizzle/migrations/meta`, { recursive: true });
  await cp(`${INSTALLED}/package.json`, `${world}/package.json`);
  await cp(`${INSTALLED}/dist/storage.js`, files().storage);
  await cp(`${INSTALLED}/dist/storage.d.ts`, files().types);
  await cp(`${INSTALLED}/src/drizzle/migrations/meta/_journal.json`, files().journal);
});

afterAll(async () => {
  if (world) await rm(world, { recursive: true, force: true });
});

describe("Workflow journal storage patch", () => {
  it("applies to a copy of the installed package and is idempotent", async () => {
    await patchWorkflowJournalStorage(replaceExact, world);
    const first = await Promise.all(Object.values(files()).map((path) => readFile(path)));
    await patchWorkflowJournalStorage(replaceExact, world);
    const second = await Promise.all(Object.values(files()).map((path) => readFile(path)));
    expect(second.map((bytes, i) => bytes.equals(first[i]!))).toEqual([true, true, true, true, true]);
    await expect(execFileAsync(process.execPath, ["--check", files().storage])).resolves.toBeDefined();
    await expect(execFileAsync(process.execPath, ["--check", files().runtime])).resolves.toBeDefined();
  });

  it("serves step input and output from the events and writes the row columns only until the flag is on", async () => {
    const storage = await readFile(files().storage, "utf8");
    expect(storage).not.toContain("input: eventData.input,\n                    status: 'pending'");
    expect(storage).not.toContain("input: lazyData.input,\n                            status: 'pending'");
    expect(storage).not.toContain("output: eventData.result,");
    expect(storage).toContain("...(stepPayloadColumnsEnabled() ? { input: eventData.input } : {}),");
    expect(storage).toContain("...(stepPayloadColumnsEnabled() ? { input: lazyData.input } : {}),");
    expect(storage).toContain("...(stepPayloadColumnsEnabled() ? { output: eventData.result } : {}),");
    expect(storage).toContain("const stepPayloadColumnsEnabled = () => !payloadBlobWritesEnabled();");
    // The validation read of a failed step_completed UPDATE stays on the transaction's connection.
    expect(count(storage, "await getStepForValidation.execute({")).toBe(3);
    expect(storage).toContain("const [existing] = await tx\n                            .select({ status: Schema.steps.status })");
    // The synthetic step_created event of a lazy start still carries the input.
    expect(storage).toContain("input: lazyData.input,\n                                },");
    expect(storage).toContain("step = deserializeStepError(compact({ ...stepValue, input: eventData.input }));");
    expect(storage).toContain(": await stepInputFromEvent(tx, effectiveRunId, data.correlationId));");
    expect(storage).toContain("step = deserializeStepError(compact({ ...stepValue, output: eventData.result }));");
    expect(storage).toContain("`step_completed for step \"${data.correlationId}\" could not be created`");
    expect(count(storage, "await attachStepPayloads(drizzle, ")).toBe(2);
    expect(storage).toContain("async function attachStepPayloads(db, runId, rows) {");
  });

  it("reads a run's slot marker once per process", async () => {
    const storage = await readFile(files().storage, "utf8");
    expect(storage).toContain("const SLOT_MARKED_RUNS_MAX = 50_000;");
    expect(storage).toContain("if (slotMarkedRuns.has(runId))\n        return nextSlotId(runId);");
    expect(count(storage, "rememberSlotMarker(runId);")).toBe(2);
    expect(storage).not.toContain("return row ? nextSlotId(runId) : `wevt_${legacyEventUlid()}`;");
  });

  it("splits large payload strings into blobs on write and restores them on every read", async () => {
    const storage = await readFile(files().storage, "utf8");
    expect(storage).toContain("from './osinara-payload-blobs.js';");
    expect(storage).toContain("values = { ...values, eventData: await dedupeEventData(db, values.runId, values.eventData) };");
    expect(storage).toContain("process.env.OSINARA_WORKFLOW_PAYLOAD_BLOBS === '1'");
    expect(storage).toContain("export function resetPayloadBlobCacheForTest()");
    expect(await readFile(files().types, "utf8")).toContain("export declare function resetPayloadBlobCacheForTest(): void;");
    expect(storage).toContain("ON CONFLICT (hash) DO UPDATE SET touched_at = now()");
    expect(storage).toContain("for (const hash of [...blobs.keys()].sort()) {");
    // reportSkippedSlots, the run_started preload, the inline delta, get, list, listByCorrelationId,
    // stepInputFromEvent and attachStepPayloads.
    expect(count(storage, "await restoreEventData(")).toBe(8);
    expect(storage).not.toContain(".map((e) => {\n                    e.eventData ||= e.eventDataJson;");
    expect(storage).not.toContain("values.map((v) => {\n                    v.eventData ||= v.eventDataJson;");
    // The resume read cache of the event log (event-log-cache patch) stays in place around it.
    expect(storage).toContain("if (!hasMore) writeEventLogCache(cacheKey, data, data.at(-1)?.eventId);");
  });

  it("installs the runtime module and the schema migration", async () => {
    const runtime = await import(pathToFileURL(files().runtime).href) as typeof import("./payload-blobs.ts");
    expect(runtime.PAYLOAD_BLOB_MIN_CHARS).toBe(2_048);
    expect(runtime.splitPayload(new Uint8Array(Buffer.from("devl[1]")))).toBeNull();
    const migration = await readFile(files().migration, "utf8");
    expect(migration).toContain('CREATE TABLE "workflow"."workflow_payload_blobs"');
    expect(migration).toContain('"touched_at" timestamp DEFAULT now() NOT NULL');
    expect(migration).toContain('CREATE TABLE "workflow"."workflow_payload_blob_refs"');
    const journal = JSON.parse(await readFile(files().journal, "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entries = journal.entries;
    expect(entries.at(-1)).toMatchObject({ idx: 20, tag: PAYLOAD_BLOBS_MIGRATION_TAG });
    expect(entries.at(-1)!.when).toBeGreaterThan(entries.at(-2)!.when);
    expect(entries.filter((entry) => entry.tag === PAYLOAD_BLOBS_MIGRATION_TAG)).toHaveLength(1);
  });
});
