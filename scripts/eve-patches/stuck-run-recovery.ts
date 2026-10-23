/**
 * The Postgres world re-enqueues only the runs interrupted mid-flight at startup, and keeps
 * re-enqueueing runs whose retry job was lost afterwards.
 *
 * Exports:
 * - `patchStuckRunRecovery`: installs `osinara-stuck-run-recovery.js` next to the driver, replaces
 *   the world's `reenqueueActiveRuns` in `start()` with `requeueInFlightRuns`, starts the stuck-run
 *   scan there and stops it in `close()`.
 * - `STUCK_RUN_RECOVERY_SEAMS`: the exact before/after pairs, for the contract test on a copy.
 *
 * Key construct:
 * - The world used to re-enqueue every active run when it started; that is what unstuck the private
 *   chat on 2 October 2026, but only after a manual restart. The scan reuses the same queue call for
 *   the few runs that need it, so recovery needs neither a restart nor a deploy.
 * - That startup replay read every parked session's whole event log on each start and grew with the
 *   number of chats (ilkruglov 7afdc12: 79 runs after one deploy). A parked session wakes on its
 *   hook and a sleep's timer is a queue job that survives a restart, so only interrupted runs are
 *   enqueued now; the seam's `reenqueueActiveRuns` import goes away with the call.
 */
import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";

const OLD_IMPORT = `import { reenqueueActiveRuns, SPEC_VERSION_CURRENT } from '@workflow/world';`;

const NEW_IMPORT = `import { getQueueTopicPrefix, resolveQueueNamespace, SPEC_VERSION_CURRENT } from '@workflow/world';
import { releaseDeadWorkerLocks, requeueInFlightRuns, startStuckRunRecovery } from './osinara-stuck-run-recovery.js';`;

const OLD_STREAMER = `    const streamer = createStreamer(pool, drizzle);
    return {`;

const NEW_STREAMER = `    const streamer = createStreamer(pool, drizzle);
    let stopStuckRunRecovery;
    return {`;

const OLD_LIFECYCLE = `        async start() {
            await queue.start();
            await reenqueueActiveRuns(storage.runs, queue.queue, 'world-postgres', config.namespace);
        },
        async close() {
            await queue.close();`;

const NEW_LIFECYCLE = `        async start() {
            const startedAt = new Date();
            await queue.start();
            // Jobs locked by a process that died wait four hours for graphile's own expiry; one agent process runs,
            // so every lock older than this start belongs to a dead one (ilkruglov b8126607).
            await releaseDeadWorkerLocks(pool, startedAt);
            const queuePrefix = getQueueTopicPrefix('workflow', resolveQueueNamespace(config.namespace));
            // Only runs interrupted mid-flight are re-enqueued; a parked session wakes on its hook, and
            // replaying every active run made each start grow with the chat count (ilkruglov 7afdc12).
            await requeueInFlightRuns({ enqueue: queue.queue, pool, queuePrefix });
            // A run whose retry job was lost waits for this scan instead of the next restart.
            stopStuckRunRecovery ??= startStuckRunRecovery({ enqueue: queue.queue, pool, queuePrefix });
        },
        async close() {
            stopStuckRunRecovery?.();
            stopStuckRunRecovery = undefined;
            await queue.close();`;

/** Before/after pairs of `dist/index.js`, in application order. */
export const STUCK_RUN_RECOVERY_SEAMS: ReadonlyArray<readonly [before: string, after: string]> = [
  [OLD_IMPORT, NEW_IMPORT],
  [OLD_STREAMER, NEW_STREAMER],
  [OLD_LIFECYCLE, NEW_LIFECYCLE],
];

export async function patchStuckRunRecovery(
  replace: (path: string, before: string, after: string) => Promise<void>,
): Promise<void> {
  const world = resolve("node_modules/@workflow/world-postgres");
  const pkg = JSON.parse(await readFile(`${world}/package.json`, "utf8")) as { version: string };
  if (pkg.version !== "5.0.0-beta.35") {
    throw new Error("AGENT_WORKFLOW_PATCH_VERSION_UNSUPPORTED: Expected world-postgres 5.0.0-beta.35");
  }
  await writeFile(
    `${world}/dist/osinara-stuck-run-recovery.js`,
    stripTypeScriptTypes(await readFile("scripts/eve-runtime/stuck-run-recovery.ts", "utf8")),
  );
  const index = `${world}/dist/index.js`;
  for (const [before, after] of STUCK_RUN_RECOVERY_SEAMS) await replace(index, before, after);
}
