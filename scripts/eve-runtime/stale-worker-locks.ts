/** Installed by the version-pinned Workflow patch; releases queue locks left behind by a process that died. */

interface QueryablePool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export const GRAPHILE_WORKER_SCHEMA = "graphile_worker";

// Graphile 0.16.6 locks a job (and its serialized job queue) under the worker id that runs it and
// frees that lock only after four hours. A process killed mid-step (kill, OOM, a deploy without
// drain) takes its worker ids with it, so the turn it ran and every later message of that chat
// queue behind a lock nobody will release, and the chat stays silent until the expiry. The
// in-process recovery (scripts/eve-patches/postgres-connection-recovery.ts) covers only a worker
// that died inside a live process; this covers the process itself. One agent process runs, so a
// lock taken before this process started can only belong to a dead worker; with several replicas
// this would steal live jobs and must become a heartbeat check instead.
export async function releaseStaleWorkerLocks(
  pool: QueryablePool,
  startedAt: Date,
  schema: string = GRAPHILE_WORKER_SCHEMA,
): Promise<number> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`AGENT_WORKFLOW_SCHEMA_INVALID: ${schema}`);
  const result = await pool.query(
    `WITH stale AS (
       SELECT DISTINCT locked_by FROM "${schema}"._private_jobs
        WHERE locked_by IS NOT NULL AND locked_at < $1
       UNION
       SELECT DISTINCT locked_by FROM "${schema}"._private_job_queues
        WHERE locked_by IS NOT NULL AND locked_at < $1
     ), released AS (
       SELECT "${schema}".force_unlock_workers(ARRAY(SELECT locked_by FROM stale))
     )
     SELECT (SELECT count(*) FROM stale) AS workers FROM released`,
    [startedAt],
  );
  const workers = Number(result.rows[0]?.workers ?? 0);
  if (workers > 0) {
    console.warn(JSON.stringify({ code: "AGENT_WORKFLOW_STALE_WORKER_LOCKS_RELEASED", workers }));
  }
  return workers;
}
