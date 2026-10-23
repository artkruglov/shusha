/**
 * Re-enqueues Workflow runs whose next step lost its queue job.
 *
 * Exports:
 * - `STUCK_RETRY_AFTER_MS`, `STUCK_STEP_STARTED_AFTER_MS`, `STUCK_RUN_SCAN_INTERVAL_MS`: limits.
 * - `findStuckRuns`: active runs whose last event is a retry nobody picked up, or a step start far
 *   older than any step may run.
 * - `releaseDeadWorkerLocks`: startup release of queue jobs still locked by processes that died.
 * - `startStuckRunRecovery`: scans on an interval and enqueues each found run the way the world's
 *   own startup recovery did; returns a stop function.
 * - `findInFlightRuns`, `requeueInFlightRuns`: startup recovery of the runs interrupted mid-flight
 *   only; parked sessions and sleeps are left to the events that wake them.
 *
 * Key construct:
 * - On 1 October 2026 a turn step recorded `step_retrying`, but the follow-up job that should have
 *   run it again was written to a closed HTTP connection and never existed. Workflow's own backstop
 *   skips steps that already retried, so the run stayed pending and the private chat was silent
 *   for 8.5 hours, until a restart re-enqueued every active run. This scan does the same for the
 *   runs that need it, without a restart. Replay is idempotent, so a duplicate enqueue is safe.
 * - Runs that wait on a hook, a sleep or a parked session end on other events and are never touched.
 * - Startup used to re-enqueue every active run (`reenqueueActiveRuns`), so each parked session
 *   replayed its whole event log on every start, and the start grew with the number of chats
 *   (ilkruglov 7afdc12, 583c5ef). Only the runs interrupted mid-flight are re-enqueued now.
 */

export const STUCK_RETRY_AFTER_MS = 10 * 60 * 1000;
// Ilya's 25 minutes would requeue a step our transport still legitimately holds: the flow request may live 35 minutes
// (`workflow-transport.ts`), so a started step counts as stuck only after 40.
export const STUCK_STEP_STARTED_AFTER_MS = 40 * 60 * 1000;
export const STUCK_RUN_SCAN_INTERVAL_MS = 5 * 60 * 1000;

interface QueryablePool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface StuckRun {
  lastEvent: string;
  runId: string;
  workflowName: string;
}

export async function findStuckRuns(
  pool: QueryablePool,
  limits: { retryAfterMs: number; stepStartedAfterMs: number } = {
    retryAfterMs: STUCK_RETRY_AFTER_MS,
    stepStartedAfterMs: STUCK_STEP_STARTED_AFTER_MS,
  },
): Promise<StuckRun[]> {
  // Event times are stored without a zone in the session's local time, hence LOCALTIMESTAMP.
  const result = await pool.query(
    `SELECT r.id AS run_id, r.name AS workflow_name, last.type AS last_event
       FROM workflow.workflow_runs r
       JOIN LATERAL (
         SELECT e.type, e.created_at FROM workflow.workflow_events e
          WHERE e.run_id = r.id
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT 1
       ) last ON true
      WHERE r.status IN ('pending', 'running')
        AND ((last.type = 'step_retrying' AND last.created_at < LOCALTIMESTAMP - make_interval(secs => $1::double precision))
          OR (last.type = 'step_started' AND last.created_at < LOCALTIMESTAMP - make_interval(secs => $2::double precision)))
      ORDER BY last.created_at
      LIMIT 50`,
    [limits.retryAfterMs / 1000, limits.stepStartedAfterMs / 1000],
  );
  return result.rows.flatMap((row) =>
    typeof row.run_id === "string" && typeof row.workflow_name === "string" && typeof row.last_event === "string"
      ? [{ lastEvent: row.last_event, runId: row.run_id, workflowName: row.workflow_name }]
      : []);
}

/**
 * Releases the queue jobs and job queues locked by workers that started before this process.
 *
 * A worker locks a job while running it; graphile-worker frees a lock only after four hours, so a
 * process killed mid-step (a restart, a crash, an OOM, a deploy that stopped waiting) left its turn
 * and every later message of that chat waiting: Ft86 was silent from 14:31 on 5 October 2026 until
 * the lock was freed by hand. The installation runs one agent process, so every lock older than
 * this process belongs to a dead one. With several replicas this would steal live jobs; it must
 * then become a heartbeat check.
 */
export async function releaseDeadWorkerLocks(pool: QueryablePool, startedAt: Date): Promise<number> {
  const result = await pool.query(
    `WITH dead AS (
       SELECT DISTINCT locked_by FROM graphile_worker._private_jobs
        WHERE locked_by IS NOT NULL AND locked_at < $1
       UNION
       SELECT DISTINCT locked_by FROM graphile_worker._private_job_queues
        WHERE locked_by IS NOT NULL AND locked_at < $1
     ), released AS (
       SELECT graphile_worker.force_unlock_workers(ARRAY(SELECT locked_by FROM dead))
     )
     SELECT (SELECT count(*) FROM dead) AS workers FROM released`,
    [startedAt],
  );
  const workers = Number(result.rows[0]?.workers ?? 0);
  if (workers > 0) {
    console.warn(JSON.stringify({ code: "AGENT_WORKFLOW_DEAD_WORKER_LOCKS_RELEASED", workers }));
  }
  return workers;
}

/** Last events of a run that ends on another event: a parked session's hook, a sleep's timer. */
const PARKED_LAST_EVENTS = ["hook_created", "wait_created"];
/**
 * A session that waits on a hook created turns ago ends its last turn on step_completed, like a
 * run interrupted between steps. The two are told apart by age: a process restarts within
 * minutes, so a completed step older than this has nothing in flight behind it (the deploy's
 * own wait for turns uses the same window).
 */
export const INFLIGHT_COMPLETED_STEP_WITHIN_MS = 10 * 60 * 1000;

/**
 * Active runs whose last event leaves the next action to this process: a run interrupted while a
 * step ran, right after creation, or between steps, where "between steps" is a completed step
 * younger than the window or one with no hook to wake the run (a session resting on its hook is
 * left alone). Pages by run id so a large installation is read in bounded chunks.
 */
export async function findInFlightRuns(pool: QueryablePool, pageSize = 500): Promise<StuckRun[]> {
  const found: StuckRun[] = [];
  let after = "";
  while (true) {
    const result = await pool.query(
      `SELECT r.id AS run_id, r.name AS workflow_name, last.type AS last_event
         FROM workflow.workflow_runs r
         JOIN LATERAL (
           SELECT e.type, e.created_at FROM workflow.workflow_events e
            WHERE e.run_id = r.id
            ORDER BY e.created_at DESC, e.id DESC
            LIMIT 1
         ) last ON true
        WHERE r.status IN ('pending', 'running') AND r.id > $1
          AND last.type <> ALL($2::text[])
          AND (last.type <> 'step_completed'
               OR last.created_at > LOCALTIMESTAMP - make_interval(secs => $4::double precision)
               OR NOT EXISTS (SELECT 1 FROM workflow.workflow_hooks h WHERE h.run_id = r.id))
        ORDER BY r.id
        LIMIT $3`,
      [after, PARKED_LAST_EVENTS, pageSize, INFLIGHT_COMPLETED_STEP_WITHIN_MS / 1000],
    );
    for (const row of result.rows) {
      if (typeof row.run_id !== "string" || typeof row.workflow_name !== "string" || typeof row.last_event !== "string") continue;
      found.push({ lastEvent: row.last_event, runId: row.run_id, workflowName: row.workflow_name });
      after = row.run_id;
    }
    if (result.rows.length < pageSize) return found;
  }
}

/**
 * Startup recovery: enqueues the in-flight runs and nothing else. Replaces the world's own
 * `reenqueueActiveRuns`, which replayed every active run, parked sessions included, on each start
 * (79 runs on one production installation, 4 October 2026, growing with the number of chats).
 */
export async function requeueInFlightRuns(input: {
  enqueue: (queueName: string, message: { runId: string }) => Promise<unknown>;
  pool: QueryablePool;
  queuePrefix: string;
}): Promise<number> {
  const runs = await findInFlightRuns(input.pool);
  for (const run of runs) {
    await input.enqueue(`${input.queuePrefix}${run.workflowName}`, { runId: run.runId });
  }
  if (runs.length > 0) {
    console.info(JSON.stringify({ code: "AGENT_WORKFLOW_INFLIGHT_RUNS_REQUEUED", count: runs.length }));
  }
  return runs.length;
}

export function startStuckRunRecovery(input: {
  enqueue: (queueName: string, message: { runId: string }) => Promise<unknown>;
  intervalMs?: number;
  pool: QueryablePool;
  queuePrefix: string;
}): () => void {
  let running = false;
  const scan = async () => {
    if (running) return;
    running = true;
    try {
      for (const run of await findStuckRuns(input.pool)) {
        await input.enqueue(`${input.queuePrefix}${run.workflowName}`, { runId: run.runId });
        console.warn(JSON.stringify({ code: "AGENT_WORKFLOW_STUCK_RUN_REQUEUED", lastEvent: run.lastEvent, runId: run.runId }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        code: "AGENT_WORKFLOW_STUCK_RUN_SCAN_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void scan(), input.intervalMs ?? STUCK_RUN_SCAN_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
