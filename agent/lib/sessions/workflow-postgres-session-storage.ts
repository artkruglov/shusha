/**
 * PostgreSQL Workflow physical session retention adapter.
 *
 * Exports:
 * - `deletePostgresEveSession`: atomically deletes one verified terminal run and its turn runs.
 * - `deleteConfiguredPostgresEveSession`: fail-fast environment boundary for scheduled retention.
 * - `deleteOrphanedPostgresEveRuns`: sweeps turn runs whose session row is already gone.
 *
 * Invariants:
 * - Table names come from the pinned package's public exported schema.
 * - The run row is locked and removed last; any failure rolls the transaction back.
 * - A hook whose token-retention window is still open blocks deletion; Workflow itself treats an
 *   absent or past window as ended.
 * - A run parked for an hour on a retired conversation is cancelled before deletion.
 * - Каждый ход Eve это отдельный дочерний run со своим журналом, связанный с сессией через
 *   `attributes->>'$rootRunId'`. Удаление одной строки сессии их не касалось, и 24 сентября 2026
 *   на проде три четверти журнала (6829 событий из 9211) принадлежали ходам уже удалённых
 *   сессий: прочитать их некому, а места они занимали больше, чем все данные семьи.
 */
import pg from "pg";

import { AppError } from "../app-error.js";

const { Client } = pg;
const EVE_RUN_ID_PATTERN = /^wrun_[A-Z0-9]{26}$/u;
const TERMINAL_RUN_STATUSES = new Set(["cancelled", "completed", "failed"]);
// A run untouched for this long, whose conversation was retired a day earlier, is parked for good.
const PARKED_RUN_IDLE_INTERVAL = "1 hour";
const PER_RUN_PROJECTIONS = [
  "DELETE FROM workflow.workflow_stream_chunks WHERE run_id = ANY($1)",
  "DELETE FROM workflow.workflow_waits WHERE run_id = ANY($1)",
  "DELETE FROM workflow.workflow_hooks WHERE run_id = ANY($1)",
  "DELETE FROM workflow.workflow_steps WHERE run_id = ANY($1)",
  "DELETE FROM workflow.workflow_events WHERE run_id = ANY($1)",
  "DELETE FROM workflow.workflow_event_slots WHERE run_id = ANY($1)",
  "DELETE FROM workflow.workflow_payload_blob_refs WHERE run_id = ANY($1)",
] as const;

/**
 * Removes the runs' projections and, in the same transaction, the payload blobs those runs were the
 * last to refer to: a deleted conversation leaves no text behind until a sweep. A writer touches a
 * blob row under its lock before adding a reference, so the delete either waits for that commit and
 * sees the fresh reference, or wins and the writer recreates the row.
 */
async function deleteRunProjections(client: WorkflowQueryClient, ids: readonly string[]): Promise<void> {
  const referenced = await client.query(
    "SELECT DISTINCT hash FROM workflow.workflow_payload_blob_refs WHERE run_id = ANY($1)",
    [ids],
  );
  for (const statement of PER_RUN_PROJECTIONS) {
    await client.query(statement, [ids]);
  }
  const hashes = referenced.rows.map((row) => String(row.hash));
  if (hashes.length > 0) {
    // The lock waits out a writer that touched a blob under its own lock; the delete is then a
    // separate statement with a fresh snapshot that sees that writer's reference (a single DELETE
    // re-checked after the wait would still run NOT EXISTS on its old snapshot). Hash order, as
    // every writer takes its blob locks, so the two never wait in a cycle.
    await client.query(
      "SELECT hash FROM workflow.workflow_payload_blobs WHERE hash = ANY($1) ORDER BY hash FOR UPDATE",
      [hashes],
    );
    await client.query(
      `DELETE FROM workflow.workflow_payload_blobs AS blob
        WHERE blob.hash = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM workflow.workflow_payload_blob_refs AS ref WHERE ref.hash = blob.hash)`,
      [hashes],
    );
  }
}

interface WorkflowQueryClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
}

export async function deletePostgresEveSession(
  runId: string,
  client: WorkflowQueryClient,
): Promise<void> {
  if (!EVE_RUN_ID_PATTERN.test(runId)) {
    throw new AppError(
      "AGENT_EVE_SESSION_ID_INVALID",
      "Идентификатор удаляемой Eve-сессии некорректен",
    );
  }

  await client.query("BEGIN");
  try {
    // Lock the primary row before proving that application retirement cannot race active Workflow.
    const run = await client.query(
      `SELECT status::text AS status, updated_at <= now() - $2::interval AS parked
         FROM workflow.workflow_runs WHERE id = $1 FOR UPDATE`,
      [runId, PARKED_RUN_IDLE_INTERVAL],
    );
    const status = run.rows[0]?.status;
    if (typeof status !== "string") {
      throw new AppError(
        "AGENT_EVE_SESSION_STORAGE_MISSING",
        `Не найдены данные удаляемой Eve-сессии ${runId}`,
      );
    }
    if (!TERMINAL_RUN_STATUSES.has(status)) {
      // An Eve session run parks on a hook and stays `running` forever (upstream 63d7e65). The
      // caller only reaches here for a conversation retired a day earlier without a pending
      // operation, so a run idle since then will never be answered and is closed here.
      if (run.rows[0]?.parked !== true) {
        throw new AppError(
          "AGENT_EVE_SESSION_STORAGE_ACTIVE",
          `Eve-сессия ${runId} ещё выполняется и не может быть удалена`,
        );
      }
      await client.query(
        `UPDATE workflow.workflow_runs
            SET status = 'cancelled', completed_at = coalesce(completed_at, now()), updated_at = now()
          WHERE id = $1`,
        [runId],
      );
    }

    // Ход сессии это отдельный run, и его журнал уходит вместе с сессией: продолжать его некуда.
    // Незавершённый ход удаляемой сессии закрывается по той же причине, что и припаркованный корень.
    const children = await client.query(
      `SELECT id FROM workflow.workflow_runs
        WHERE attributes->>'$rootRunId' = $1 AND id <> $1 FOR UPDATE`,
      [runId],
    );
    const ids = [runId, ...children.rows.map((row) => String(row.id))];
    if (ids.length > 1) {
      await client.query(
        `UPDATE workflow.workflow_runs
            SET status = 'cancelled', completed_at = coalesce(completed_at, now()), updated_at = now()
          WHERE id = ANY($1) AND id <> $2 AND status NOT IN ('cancelled', 'completed', 'failed')`,
        [ids, runId],
      );
    }

    // Hooks carry externally reusable tokens, so an open retention window still blocks deletion.
    // An absent or past window is exactly what Workflow treats as ended.
    const hook = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM workflow.workflow_hooks
          WHERE run_id = ANY($1) AND token_retention_until IS NOT NULL AND token_retention_until > now()
       ) AS exists`,
      [ids],
    );
    if (hook.rows[0]?.exists === true) {
      throw new AppError(
        "AGENT_EVE_SESSION_HOOK_RETENTION_ACTIVE",
        `Eve-сессия ${runId} ещё содержит защищённые Workflow hooks`,
      );
    }

    // Public schema has no foreign keys, so remove every per-run projection before the run itself.
    await deleteRunProjections(client, ids);
    if (ids.length > 1) {
      await client.query(
        "DELETE FROM workflow.workflow_runs WHERE id = ANY($1) AND id <> $2",
        [ids, runId],
      );
    }
    const deletedRun = await client.query(
      "DELETE FROM workflow.workflow_runs WHERE id = $1",
      [runId],
    );
    if (deletedRun.rowCount !== 1) {
      throw new AppError(
        "AGENT_EVE_SESSION_STORAGE_DELETE_INCOMPLETE",
        `Не удалось удалить данные Eve-сессии ${runId}`,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function deleteConfiguredPostgresEveSession(runId: string): Promise<void> {
  const connectionString = process.env.WORKFLOW_POSTGRES_URL;
  if (!connectionString) {
    throw new AppError(
      "AGENT_WORKFLOW_DATABASE_CONFIG_MISSING",
      "Не задано подключение к базе Workflow",
    );
  }

  // A short-lived client keeps the retention job independent from the world worker's pool lifecycle.
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await deletePostgresEveSession(runId, client);
  } finally {
    await client.end();
  }
}

/** Дочерних ходов удалённых сессий никто уже не позовёт, поэтому их убирает отдельный проход. */
const ORPHAN_SWEEP_BATCH = 200;

export async function deleteOrphanedPostgresEveRuns(client: WorkflowQueryClient): Promise<number> {
  await client.query("BEGIN");
  try {
    // Сирота это завершённый дочерний ход, чьей сессии в таблице уже нет. Час простоя оставляет
    // запас живому ходу, чья сессия исчезает прямо сейчас: удалять его на полпути нельзя.
    const orphans = await client.query(
      `SELECT c.id FROM workflow.workflow_runs c
         LEFT JOIN workflow.workflow_runs p ON p.id = c.attributes->>'$rootRunId'
        WHERE c.attributes ? '$rootRunId'
          AND c.attributes->>'$rootRunId' <> c.id
          AND p.id IS NULL
          AND c.status IN ('cancelled', 'completed', 'failed')
          AND c.updated_at <= now() - $1::interval
        ORDER BY c.updated_at
        LIMIT $2
        FOR UPDATE OF c SKIP LOCKED`,
      [PARKED_RUN_IDLE_INTERVAL, ORPHAN_SWEEP_BATCH],
    );
    const ids = orphans.rows.map((row) => String(row.id));
    if (ids.length === 0) {
      await client.query("COMMIT");
      return 0;
    }
    await deleteRunProjections(client, ids);
    await client.query("DELETE FROM workflow.workflow_runs WHERE id = ANY($1)", [ids]);
    await client.query("COMMIT");
    return ids.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * Задачи очереди graphile-worker, которые ждут уже удалённый ран. Чистка сирот убирает ран, а его
 * отложенные задачи (`sessionTimeoutWorkflow` и подобные) остаются и ретраятся до 49 раз, каждый раз
 * падая с `WorkflowRunNotFoundError` и засоряя лог (прод 2 октября 2026, 82 задачи, у части до 42 попыток).
 * Задача считается мёртвой, только если она сама назвала ран в последней ошибке и этого рана в таблице
 * нет; залоченные воркером не трогаются, удаляет публичная `graphile_worker.complete_jobs`.
 */
export async function deleteDeadWorkflowQueueJobs(client: WorkflowQueryClient): Promise<number> {
  const result = await client.query(
    `WITH dead AS (
       SELECT job.id FROM graphile_worker._private_jobs job
        WHERE job.locked_at IS NULL AND job.attempts > 0
          AND job.last_error LIKE '%WorkflowRunNotFoundError%'
          AND substring(job.last_error from 'wrun_[A-Z0-9]{26}') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM workflow.workflow_runs run
             WHERE run.id = substring(job.last_error from 'wrun_[A-Z0-9]{26}'))
        ORDER BY job.id LIMIT $1
     )
     SELECT count(*)::int AS removed FROM graphile_worker.complete_jobs(ARRAY(SELECT id FROM dead))`,
    [ORPHAN_SWEEP_BATCH],
  );
  return Number(result.rows[0]?.removed ?? 0);
}

export async function deleteConfiguredOrphanedPostgresEveRuns(): Promise<number> {
  const connectionString = process.env.WORKFLOW_POSTGRES_URL;
  if (!connectionString) {
    throw new AppError(
      "AGENT_WORKFLOW_DATABASE_CONFIG_MISSING",
      "Не задано подключение к базе Workflow",
    );
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    let removed = 0;
    // Один проход убирает ограниченный пакет: минутное расписание доберёт остальное.
    for (let batch = 0; batch < 5; batch += 1) {
      const deleted = await deleteOrphanedPostgresEveRuns(client);
      removed += deleted;
      if (deleted < ORPHAN_SWEEP_BATCH) break;
    }
    const deadJobs = await deleteDeadWorkflowQueueJobs(client);
    if (deadJobs > 0) {
      console.error(JSON.stringify({ code: "AGENT_WORKFLOW_DEAD_JOBS_DELETED", jobs: deadJobs }));
    }
    return removed;
  } finally {
    await client.end();
  }
}
