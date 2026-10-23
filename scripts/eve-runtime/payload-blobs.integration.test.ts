/**
 * Event payload blobs against the real Workflow schema.
 *
 * Constructs covered:
 * - Three events of two runs carrying the same 8 KB string store that string once; each run holds
 *   one reference row; the event rows are far smaller than the payloads they stand for.
 * - `events.list`, `events.get` and `steps.get` return payloads equal to what was written, and the
 *   runtime-facing form (`zstd` + `devl`) is preserved.
 * - A second storage instance (another process, empty cache) restores them from the table.
 * - A payload below the threshold is stored as written.
 */
import { createHash, randomUUID } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { createClient } from "../../node_modules/@workflow/world-postgres/dist/drizzle/index.js";
import * as storageModule from "../../node_modules/@workflow/world-postgres/dist/storage.js";

const { createEventsStorage, createStepsStorage } = storageModule;
// The export exists once scripts/apply-eve-patches.ts has run; the shipped typings predate it.
const resetPayloadBlobCacheForTest = (storageModule as unknown as { resetPayloadBlobCacheForTest: () => void }).resetPayloadBlobCacheForTest;

const big = (seed: string) => Array.from({ length: 128 }, (_, i) => createHash("sha256").update(`${seed}${i}`).digest("hex")).join(" ");
const payload = (flat: unknown[]) => new Uint8Array(Buffer.concat([Buffer.from("zstd"), zstdCompressSync(Buffer.concat([Buffer.from("devl"), Buffer.from(JSON.stringify(flat))]))]));
const decoded = (bytes: unknown) => {
  const buffer = Buffer.from(bytes as Uint8Array);
  expect(buffer.subarray(0, 4).toString()).toBe("zstd");
  const body = zstdDecompressSync(buffer.subarray(4));
  expect(body.subarray(0, 4).toString()).toBe("devl");
  return JSON.parse(body.subarray(4).toString()) as unknown[];
};

describe.skipIf(process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true" || !process.env.WORKFLOW_POSTGRES_URL)("event payload blobs", () => {
  it("stores a repeated large string once and restores every payload exactly", async () => {
    // Writes are off by default (two releases: every reader restores first); this test turns them on.
    process.env.OSINARA_WORKFLOW_PAYLOAD_BLOBS = "1";
    const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 2 });
    const drizzle = createClient(pool);
    const events = createEventsStorage(drizzle);
    const steps = createStepsStorage(drizzle);
    const prompt = big("system prompt");
    const runs = [`wrun_${ulid()}`, `wrun_${ulid()}`];
    const stepId = `step_${randomUUID()}`;
    const inputFlat = [{ system: 1, text: 2 }, prompt, "hello"];
    const resultFlat = [{ system: 1, history: 2 }, prompt, big("history")];
    try {
      for (const runId of runs) {
        await events.create(runId, { eventData: { deploymentId: "blob-test", input: payload(inputFlat), workflowName: "blob-test" }, eventType: "run_created" } as never);
        await events.create(runId, { eventType: "run_started" } as never);
      }
      await events.create(runs[0]!, { correlationId: stepId, eventData: { input: payload(inputFlat), stepName: "s" }, eventType: "step_created" } as never);
      await events.create(runs[0]!, { correlationId: stepId, eventData: { stepName: "s" }, eventType: "step_started" } as never);
      await events.create(runs[0]!, { correlationId: stepId, eventData: { result: payload(resultFlat), stepName: "s" }, eventType: "step_completed" } as never);
      await events.create(runs[0]!, { correlationId: `step_${randomUUID()}`, eventData: { input: payload([{ a: 1 }, "small"]), stepName: "t" }, eventType: "step_created" } as never);

      const hashes = [prompt, big("history")].map((value) => createHash("sha256").update(value, "utf8").digest("hex"));
      const blobs = await pool.query<{ hash: string; size: number }>("SELECT hash, size FROM workflow.workflow_payload_blobs WHERE hash = ANY($1::text[]) ORDER BY size", [hashes]);
      expect(blobs.rows.map((row) => row.size).sort((a, b) => a - b)).toEqual([Buffer.byteLength(big("history")), Buffer.byteLength(prompt)].sort((a, b) => a - b));
      const refs = await pool.query<{ run_id: string; n: string }>("SELECT run_id, count(*)::text AS n FROM workflow.workflow_payload_blob_refs WHERE run_id = ANY($1::text[]) GROUP BY run_id", [runs]);
      expect(Object.fromEntries(refs.rows.map((row) => [row.run_id, Number(row.n)]))).toEqual({ [runs[0]!]: 2, [runs[1]!]: 1 });
      const sizes = await pool.query<{ type: string; bytes: number }>(
        "SELECT type, octet_length(payload_cbor) AS bytes FROM workflow.workflow_events WHERE run_id = $1 ORDER BY id", [runs[0]!],
      );
      const runCreatedBytes = sizes.rows.find((row) => row.type === "run_created")!.bytes;
      expect(runCreatedBytes).toBeLessThan(payload(inputFlat).length / 4);

      const listed = await events.list({ runId: runs[0] } as never);
      const byType = Object.fromEntries(listed.data.map((event: { eventType: string; eventData?: Record<string, unknown> }) => [event.eventType, event.eventData]));
      expect(decoded(byType.run_created!.input)).toEqual(inputFlat);
      expect(decoded(byType.step_completed!.result)).toEqual(resultFlat);
      const created = await events.get(runs[0]!, listed.data[0]!.eventId);
      expect(decoded((created as { eventData: { input: unknown } }).eventData.input)).toEqual(inputFlat);
      const step = await steps.get(runs[0]!, stepId);
      expect(decoded(step.input)).toEqual(inputFlat);
      expect(decoded(step.output)).toEqual(resultFlat);
      const small = listed.data.find((event: { eventType: string; correlationId?: string }) => event.eventType === "step_created" && event.correlationId !== stepId) as { eventData: { input: unknown } };
      expect(decoded(small.eventData.input)).toEqual([{ a: 1 }, "small"]);

      // A writer touches the blob row it reuses, so a sweep sees it as live again.
      await pool.query("UPDATE workflow.workflow_payload_blobs SET touched_at = now() - interval '2 hours'");
      await events.create(runs[1]!, { correlationId: `step_${randomUUID()}`, eventData: { input: payload(inputFlat), stepName: "u" }, eventType: "step_created" } as never);
      const touched = await pool.query<{ fresh: boolean }>("SELECT touched_at > now() - interval '1 minute' AS fresh FROM workflow.workflow_payload_blobs WHERE hash = $1", [createHash("sha256").update(prompt, "utf8").digest("hex")]);
      expect(touched.rows[0]?.fresh).toBe(true);

      // Another process: nothing cached, the blobs come from the table.
      resetPayloadBlobCacheForTest();
      const otherPool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 1 });
      try {
        const other = createEventsStorage(createClient(otherPool));
        const page = await other.list({ runId: runs[1] } as never);
        expect(decoded((page.data[0] as { eventData: { input: unknown } }).eventData.input)).toEqual(inputFlat);
      } finally {
        await otherPool.end();
      }
      // An opaque payload that starts like an envelope comes back byte for byte.
      const opaque = new Uint8Array(Buffer.from("oblbnot an envelope"));
      await events.create(runs[1]!, { correlationId: `step_${randomUUID()}`, eventData: { input: opaque, stepName: "v" }, eventType: "step_created" } as never);
      const opaqueBack = ((await events.list({ runId: runs[1] } as never)).data as Array<{ eventData?: { input?: Uint8Array; stepName?: string } }>)
        .find((event) => event.eventData?.stepName === "v")!;
      expect(Buffer.from(opaqueBack.eventData!.input!).toString()).toBe("oblbnot an envelope");
    } finally {
      delete process.env.OSINARA_WORKFLOW_PAYLOAD_BLOBS;
      for (const runId of runs) {
        await pool.query("DELETE FROM workflow.workflow_events WHERE run_id = $1", [runId]);
        await pool.query("DELETE FROM workflow.workflow_steps WHERE run_id = $1", [runId]);
        await pool.query("DELETE FROM workflow.workflow_event_slots WHERE run_id = $1", [runId]);
        await pool.query("DELETE FROM workflow.workflow_payload_blob_refs WHERE run_id = $1", [runId]);
        await pool.query("DELETE FROM workflow.workflow_runs WHERE id = $1", [runId]);
      }
      await pool.query("DELETE FROM workflow.workflow_payload_blobs WHERE NOT EXISTS (SELECT 1 FROM workflow.workflow_payload_blob_refs r WHERE r.hash = workflow_payload_blobs.hash)");
      await pool.end();
    }
  });
});
