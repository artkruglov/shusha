/** Installed-artifact contract for the stale worker lock release patch, applied to a copy of the world package. */
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { patchStaleWorkerLockRelease } from "../eve-patches/postgres-connection-recovery.ts";

const execFileAsync = promisify(execFile);
const WORLD = resolve("node_modules/@workflow/world-postgres");
let world: string | undefined;

// Mirrors `replaceExact` in scripts/apply-eve-patches.ts: exactly one match, fully patched accepted as is.
async function replaceOnce(path: string, before: string, after: string): Promise<void> {
  const source = await readFile(path, "utf8");
  const afterCount = source.split(after).length - 1;
  const unpatchedBeforeCount = source.split(before).length - 1 - afterCount * (after.split(before).length - 1);
  if (unpatchedBeforeCount === 0 && afterCount === 1) return;
  if (unpatchedBeforeCount !== 1 || afterCount !== 0) throw new Error(`AGENT_EVE_PATCH_MISMATCH: ${path} before=${unpatchedBeforeCount} after=${afterCount}`);
  await writeFile(path, source.split(before).join(after), "utf8");
}

afterEach(async () => {
  if (world) await rm(world, { recursive: true, force: true });
  world = undefined;
});

describe("stale worker lock release patch", () => {
  it("releases the locks older than the process start right after the queue starts, idempotently", async () => {
    world = await mkdtemp(join(tmpdir(), "osinara-world-postgres-patch-"));
    await cp(`${WORLD}/package.json`, `${world}/package.json`);
    await cp(`${WORLD}/dist/index.js`, `${world}/dist/index.js`);

    await patchStaleWorkerLockRelease(replaceOnce, world);
    const once = await readFile(`${world}/dist/index.js`, "utf8");
    await patchStaleWorkerLockRelease(replaceOnce, world);
    expect(await readFile(`${world}/dist/index.js`, "utf8")).toBe(once);

    expect(once).toContain("import { releaseStaleWorkerLocks } from './osinara-stale-worker-locks.js';");
    expect(once).toContain("        async start() {\n            const startedAt = new Date();\n            await queue.start();\n            await releaseStaleWorkerLocks(pool, startedAt);\n            await reenqueueActiveRuns(");
    // The native replay of active runs stays, and the release runs before it.
    expect(once.indexOf("releaseStaleWorkerLocks(pool, startedAt)")).toBeLessThan(once.indexOf("await reenqueueActiveRuns("));
    await expect(execFileAsync(process.execPath, ["--check", `${world}/dist/index.js`])).resolves.toBeDefined();
  });

  it("installs a runtime module the world package can import", async () => {
    world = await mkdtemp(join(tmpdir(), "osinara-world-postgres-patch-"));
    await cp(`${WORLD}/package.json`, `${world}/package.json`);
    await cp(`${WORLD}/dist/index.js`, `${world}/dist/index.js`);
    await patchStaleWorkerLockRelease(replaceOnce, world);

    const runtime = await import(pathToFileURL(`${world}/dist/osinara-stale-worker-locks.js`).href) as typeof import("./stale-worker-locks.ts");
    const pool = { query: async () => ({ rows: [{ workers: "0" }] }) };
    await expect(runtime.releaseStaleWorkerLocks(pool, new Date())).resolves.toBe(0);
  });
});
