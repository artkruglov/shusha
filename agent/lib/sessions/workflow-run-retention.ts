/**
 * Retention of finished per-turn Workflow runs.
 *
 * Exports:
 * - `pruneTerminalWorkflowRuns`: deletes a bounded batch of old finished turn runs via a client.
 * - `pruneTerminalWorkflowRunsWithin`: full batches one after another within a time budget.
 * - `pruneConfiguredTerminalWorkflowRuns`: one budgeted sweep over the configured Workflow database.
 *
 * Key constructs:
 * - Every Eve turn is its own run (`turnWorkflow`) and every turn arms a `sessionTimeoutWorkflow`
 *   run; both finish and are never touched again, but session retention deletes only the session
 *   run itself. On 26 September 2026 the production Workflow database held 4 200 finished turn
 *   runs (2.3 GB of events and steps out of 3.5 GB), and the disk check before a deploy failed.
 * - A finished run is kept for `WORKFLOW_TURN_RUN_RETENTION_DAYS` for diagnosis, then removed with
 *   the same per-run projections as a session run. A hook with an open retention window keeps it.
 * - Two days, down from seven (3 October 2026): a turn run carries ~0.3 MB of events and steps
 *   (load run, stress/load-families), so a week at 1 000 families of 100 messages a day would hold
 *   ~200 GB; incidents so far were read the same day.
 * - One batch of 50 a minute removes at most 72 000 runs a day, and every turn finishes two runs:
 *   1 000 families of 100 messages a day make ~200 000. A sweep therefore takes batches until one
 *   comes back short or 20 seconds pass, inside the same minute lock.
 * - Session runs (`workflowEntry`) stay with the application's own session retention.
 */
import pg from "pg";

import { AppError } from "../app-error.js";

const { Client } = pg;
const WORKFLOW_TURN_RUN_RETENTION_DAYS = 2;
const WORKFLOW_TURN_RUN_PRUNE_BATCH = 50;
const WORKFLOW_TURN_RUN_PRUNE_BUDGET_MILLISECONDS = 20_000;
const PRUNABLE_RUN_NAMES = ["workflow//eve//turnWorkflow", "workflow//eve//sessionTimeoutWorkflow"];

interface WorkflowQueryClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
}

export async function pruneTerminalWorkflowRuns(
  client: WorkflowQueryClient,
  options: { batch?: number; retentionDays?: number } = {},
): Promise<number> {
  const batch = options.batch ?? WORKFLOW_TURN_RUN_PRUNE_BATCH;
  const retentionDays = options.retentionDays ?? WORKFLOW_TURN_RUN_RETENTION_DAYS;
  const candidates = await client.query(
    `SELECT r.id::text AS id
       FROM workflow.workflow_runs r
      WHERE r.name = ANY($1::text[])
        AND r.status IN ('cancelled', 'completed', 'failed')
        AND coalesce(r.completed_at, r.updated_at) < now() - make_interval(days => $2::int)
        AND NOT EXISTS (
          SELECT 1 FROM workflow.workflow_hooks h
           WHERE h.run_id = r.id AND h.token_retention_until IS NOT NULL AND h.token_retention_until > now()
        )
      ORDER BY coalesce(r.completed_at, r.updated_at)
      LIMIT $3::int`,
    [PRUNABLE_RUN_NAMES, retentionDays, batch],
  );
  let deleted = 0;
  for (const row of candidates.rows) {
    const runId = row.id;
    if (typeof runId !== "string") continue;
    await client.query("BEGIN");
    try {
      // The status is re-read under the row lock: a run must not vanish while Workflow works on it.
      const locked = await client.query(
        "SELECT status::text AS status FROM workflow.workflow_runs WHERE id = $1 FOR UPDATE",
        [runId],
      );
      const status = locked.rows[0]?.status;
      if (typeof status !== "string" || !["cancelled", "completed", "failed"].includes(status)) {
        await client.query("ROLLBACK");
        continue;
      }
      for (const statement of [
        "DELETE FROM workflow.workflow_stream_chunks WHERE run_id = $1",
        "DELETE FROM workflow.workflow_waits WHERE run_id = $1",
        "DELETE FROM workflow.workflow_hooks WHERE run_id = $1",
        "DELETE FROM workflow.workflow_steps WHERE run_id = $1",
        "DELETE FROM workflow.workflow_events WHERE run_id = $1",
        "DELETE FROM workflow.workflow_event_slots WHERE run_id = $1",
        "DELETE FROM workflow.workflow_runs WHERE id = $1",
      ]) {
        await client.query(statement, [runId]);
      }
      await client.query("COMMIT");
      deleted += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  if (deleted > 0) console.info(JSON.stringify({ code: "AGENT_WORKFLOW_RUNS_PRUNED", deleted, retentionDays }));
  return deleted;
}

export async function pruneTerminalWorkflowRunsWithin(
  client: WorkflowQueryClient,
  options: { batch?: number; budgetMs?: number; clock?: () => number; retentionDays?: number } = {},
): Promise<number> {
  const batch = options.batch ?? WORKFLOW_TURN_RUN_PRUNE_BATCH;
  const budgetMs = options.budgetMs ?? WORKFLOW_TURN_RUN_PRUNE_BUDGET_MILLISECONDS;
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  let deleted = 0;
  while (clock() - startedAt < budgetMs) {
    const removed = await pruneTerminalWorkflowRuns(client, {
      batch,
      ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
    });
    deleted += removed;
    if (removed < batch) break;
  }
  return deleted;
}

export async function pruneConfiguredTerminalWorkflowRuns(): Promise<number> {
  const connectionString = process.env.WORKFLOW_POSTGRES_URL;
  if (!connectionString) {
    throw new AppError("AGENT_WORKFLOW_DATABASE_CONFIG_MISSING", "Не задано подключение к базе Workflow");
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await pruneTerminalWorkflowRunsWithin(client);
  } finally {
    await client.end();
  }
}
