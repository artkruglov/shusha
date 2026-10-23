/**
 * Contract of the stuck run recovery patch, exercised on a copy of the world package's seams.
 *
 * Constructs covered:
 * - The patched driver starts with `requeueInFlightRuns` instead of the world's `reenqueueActiveRuns`,
 *   keeps the dead-lock release and the stuck-run scan, and still parses.
 * - The patch is idempotent on an already patched copy; a copy whose seam was altered is refused.
 * - The installed tree is never written: the copy carries the three reviewed seams of the pristine
 *   `dist/index.js` in a parsable skeleton, so the test holds whatever postinstall last applied.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { STUCK_RUN_RECOVERY_SEAMS } from "../eve-patches/stuck-run-recovery.ts";

const execFileAsync = promisify(execFile);
const WORLD = "node_modules/@workflow/world-postgres";
const INDEX = `${WORLD}/dist/index.js`;

// The seams of the pristine driver (world-postgres 5.0.0-beta.35), in a skeleton that parses.
const PRISTINE_INDEX = `import { reenqueueActiveRuns, SPEC_VERSION_CURRENT } from '@workflow/world';
import { Pool } from 'pg';
export function createWorld(config = {}) {
    const pool = config.pool || new Pool();
    const drizzle = createClient(pool);
    const queue = createQueue(config, pool);
    const storage = createStorage(drizzle);
    const streamer = createStreamer(pool, drizzle);
    return {
        specVersion: SPEC_VERSION_CURRENT,
        ...storage,
        ...streamer,
        ...queue,
        async start() {
            await queue.start();
            await reenqueueActiveRuns(storage.runs, queue.queue, 'world-postgres', config.namespace);
        },
        async close() {
            await queue.close();
            await streamer.close();
        },
    };
}
`;

// The patch module resolves the world package against the working directory, so the copy is
// driven from a child process whose working directory is the temporary tree, with the installer's
// count-checked replacement.
const DRIVER = `
import { patchStuckRunRecovery } from ${JSON.stringify(join(process.cwd(), "scripts/eve-patches/stuck-run-recovery.ts"))};
import { readFile, writeFile } from "node:fs/promises";
const occurrences = (text, part) => text.split(part).length - 1;
async function replaceExact(path, before, after) {
  const source = await readFile(path, "utf8");
  const beforeCount = occurrences(source, before);
  const afterCount = occurrences(source, after);
  const unpatched = beforeCount - afterCount * occurrences(after, before);
  if (unpatched === 0 && afterCount === 1) return;
  if (unpatched !== 1 || afterCount !== 0) throw new Error("AGENT_EVE_PATCH_MISMATCH: " + path);
  await writeFile(path, source.split(before).join(after), "utf8");
}
await patchStuckRunRecovery(replaceExact);
`;

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "stuck-run-recovery-patch-"));
  await mkdir(join(root, WORLD, "dist"), { recursive: true });
  await cp(`${WORLD}/package.json`, join(root, WORLD, "package.json"));
  await writeFile(join(root, INDEX), PRISTINE_INDEX);
  await cp("scripts/eve-runtime/stuck-run-recovery.ts", join(root, "scripts/eve-runtime/stuck-run-recovery.ts"));
  await writeFile(join(root, "driver.mjs"), DRIVER);
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

async function applyOnCopy(): Promise<void> {
  await execFileAsync(process.execPath, ["--experimental-strip-types", "--no-warnings", "driver.mjs"], { cwd: root });
}

describe("stuck run recovery patch", () => {
  it("covers each pristine seam exactly once", () => {
    for (const [before] of STUCK_RUN_RECOVERY_SEAMS) {
      expect(PRISTINE_INDEX.split(before)).toHaveLength(2);
    }
  });

  it("starts the world with the in-flight requeue, the dead-lock release and the scan", async () => {
    await applyOnCopy();
    const index = await readFile(join(root, INDEX), "utf8");
    expect(index).toContain("import { getQueueTopicPrefix, resolveQueueNamespace, SPEC_VERSION_CURRENT } from '@workflow/world';");
    expect(index).toContain("import { releaseDeadWorkerLocks, requeueInFlightRuns, startStuckRunRecovery } from './osinara-stuck-run-recovery.js';");
    expect(index).not.toContain("reenqueueActiveRuns");
    expect(index).toContain("await releaseDeadWorkerLocks(pool, startedAt);");
    expect(index).toContain("await requeueInFlightRuns({ enqueue: queue.queue, pool, queuePrefix });");
    expect(index).toContain("stopStuckRunRecovery ??= startStuckRunRecovery({ enqueue: queue.queue, pool, queuePrefix });");
    expect(index).toContain("stopStuckRunRecovery?.();\n            stopStuckRunRecovery = undefined;\n            await queue.close();");
    expect(index.indexOf("await queue.start();")).toBeLessThan(index.indexOf("releaseDeadWorkerLocks(pool"));
    expect(index.indexOf("releaseDeadWorkerLocks(pool")).toBeLessThan(index.indexOf("requeueInFlightRuns({"));
    expect(index.indexOf("requeueInFlightRuns({")).toBeLessThan(index.indexOf("startStuckRunRecovery({"));
    await expect(execFileAsync(process.execPath, ["--check", join(root, INDEX)])).resolves.toBeDefined();
  });

  it("installs the runtime module with the startup and scan entry points, types stripped", async () => {
    await applyOnCopy();
    const runtime = await readFile(join(root, WORLD, "dist/osinara-stuck-run-recovery.js"), "utf8");
    for (const name of ["findInFlightRuns", "requeueInFlightRuns", "releaseDeadWorkerLocks"]) {
      expect(runtime).toContain(`export async function ${name}(`);
    }
    expect(runtime).toContain("export function startStuckRunRecovery(");
    expect(runtime).not.toMatch(/: QueryablePool/u);
    await expect(execFileAsync(process.execPath, ["--check", join(root, WORLD, "dist/osinara-stuck-run-recovery.js")])).resolves.toBeDefined();
  });

  it("is idempotent on an already patched copy", async () => {
    await applyOnCopy();
    const once = await readFile(join(root, INDEX), "utf8");
    expect(once).not.toBe(PRISTINE_INDEX);
    await applyOnCopy();
    await expect(readFile(join(root, INDEX), "utf8")).resolves.toBe(once);
  });

  it("refuses a copy where the start seam was altered", async () => {
    await writeFile(join(root, INDEX), PRISTINE_INDEX.replace("await reenqueueActiveRuns(", "await reenqueueActiveRuns( "));
    await expect(applyOnCopy()).rejects.toThrow(/AGENT_EVE_PATCH_MISMATCH/u);
    await expect(readFile(join(root, INDEX), "utf8")).resolves.toContain("await reenqueueActiveRuns( ");
  });
});
