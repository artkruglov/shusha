/**
 * Чистка задач очереди graphile-worker, ждущих удалённый ран, на настоящей схеме Workflow.
 * Нужна `WORKFLOW_POSTGRES_URL` на тестовую базу `*_test` и `RUN_DATABASE_INTEGRATION_TESTS=true`.
 */
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { deleteDeadWorkflowQueueJobs } from "./workflow-postgres-session-storage.js";

const url = process.env.WORKFLOW_POSTGRES_URL;
// The test empties the whole queue, so it runs only on a database named `*_test`; CI's workflow database
// is not one and the test is skipped there.
const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && url !== undefined &&
  new URL(url).pathname.endsWith("_test");
const suite = enabled ? describe : describe.skip;
const client = new pg.Client({ connectionString: url });
const GONE = "wrun_01M3V1QTC17QQX8N622NB1RKJS";
const ALIVE = "wrun_01M3V1QTC17QQX8N622NB1RKJT";

async function addJob(key: string, error: string | null, attempts: number, locked = false): Promise<void> {
  await client.query(
    `INSERT INTO graphile_worker._private_jobs (task_id, payload, key, attempts, last_error, locked_at, locked_by)
     SELECT id, '{}'::json, $1, $3, $2, CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN 'worker-x' END
       FROM graphile_worker._private_tasks LIMIT 1`,
    [key, error, attempts, locked],
  );
}
const remaining = async () => (await client.query("SELECT key FROM graphile_worker._private_jobs ORDER BY key")).rows.map((r) => r.key as string);

suite("dead workflow queue jobs", () => {
  beforeEach(async () => {
    if (client.listeners("error").length === 0) await client.connect();
    await client.query("DELETE FROM graphile_worker._private_jobs");
    await client.query("INSERT INTO graphile_worker._private_tasks (identifier) VALUES ('osinaraflows') ON CONFLICT DO NOTHING");
    await client.query("DELETE FROM workflow.workflow_runs WHERE id = $1", [ALIVE]);
  });
  afterAll(async () => { await client.end().catch(() => undefined); });

  it("removes a retried job whose run is gone and keeps everything else", async () => {
    await client.query(
      "INSERT INTO workflow.workflow_runs (id, deployment_id, status, name) VALUES ($1, 'd', 'running', 'w')", [ALIVE]);
    const missing = `[postgres world] Queue execution failed (500): "WorkflowRunNotFoundError: Workflow run \\"${GONE}\\" not found"`;
    await addJob("dead", missing, 8);
    await addJob("locked", missing, 8, true);
    await addJob("fresh", missing, 0);
    await addJob("other-error", "something else, wrun_01M3V1QTC17QQX8N622NB1RKJS", 5);
    await addJob("no-error", null, 3);
    await addJob("alive", missing.replace(GONE, ALIVE), 4);

    const removed = await deleteDeadWorkflowQueueJobs(client);

    const left = await remaining();
    expect(left).not.toContain("dead");
    // Locked by a worker, never failed, failed otherwise, no error, or waiting a run that exists: all stay.
    expect(left).toEqual(["alive", "fresh", "locked", "no-error", "other-error"]);
    expect(removed).toBe(1);
  });
});
