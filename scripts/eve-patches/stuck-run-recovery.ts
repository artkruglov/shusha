/**
 * The Postgres world keeps re-enqueueing runs whose retry job was lost, not only at startup.
 *
 * Export:
 * - `patchStuckRunRecovery`: installs `osinara-stuck-run-recovery.js` next to the driver and starts
 *   its scan from the world's `start()`, stopping it in `close()`.
 *
 * Key construct:
 * - The world already re-enqueues every active run when it starts; that is what unstuck the private
 *   chat on 2 October 2026, but only after a manual restart. The scan reuses the same queue call for
 *   the few runs that need it, so recovery needs neither a restart nor a deploy.
 */
import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";

const OLD_IMPORT = `import { reenqueueActiveRuns, SPEC_VERSION_CURRENT } from '@workflow/world';`;

const NEW_IMPORT = `import { getQueueTopicPrefix, reenqueueActiveRuns, resolveQueueNamespace, SPEC_VERSION_CURRENT } from '@workflow/world';
import { releaseDeadWorkerLocks, startStuckRunRecovery } from './osinara-stuck-run-recovery.js';`;

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
            await reenqueueActiveRuns(storage.runs, queue.queue, 'world-postgres', config.namespace);
            // A run whose retry job was lost waits for this scan instead of the next restart.
            stopStuckRunRecovery ??= startStuckRunRecovery({
                enqueue: queue.queue,
                pool,
                queuePrefix: getQueueTopicPrefix('workflow', resolveQueueNamespace(config.namespace)),
            });
        },
        async close() {
            stopStuckRunRecovery?.();
            stopStuckRunRecovery = undefined;
            await queue.close();`;

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
  await replace(index, OLD_IMPORT, NEW_IMPORT);
  await replace(index, OLD_STREAMER, NEW_STREAMER);
  await replace(index, OLD_LIFECYCLE, NEW_LIFECYCLE);
}
