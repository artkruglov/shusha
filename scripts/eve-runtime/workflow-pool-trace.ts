/**
 * Slow-query trace for the workflow PostgreSQL pool.
 *
 * Export:
 * - `traceWorkflowPool`: wraps a pool in place so a query over the threshold reports itself.
 *
 * Key construct:
 * - The workflow driver was the blind spot in reply latency: the only way to see that resuming a
 *   run read its whole event log was to switch production statement logging on and wait for a live
 *   message (10 сентября 2026). Wrapping the one pool covers storage, queue and streamer at once.
 * - Only the statement shape is logged, never parameter values: they carry run payloads, which
 *   hold the turn context of a family chat.
 */

const TRACED = Symbol.for("osinara.workflowPoolTrace");
const STATEMENT_LOG_LIMIT = 120;
const SLOW_QUERY_MS = 150;

interface QueryOwner {
  query: (...args: unknown[]) => unknown;
}

interface TraceablePool extends QueryOwner {
  connect: (...args: unknown[]) => unknown;
}

function statementShape(query: unknown): string {
  const text = typeof query === "string"
    ? query
    : typeof (query as { text?: unknown } | null)?.text === "string"
      ? (query as { text: string }).text
      : "";
  return text.replace(/\s+/gu, " ").trim().slice(0, STATEMENT_LOG_LIMIT);
}

function rowCount(result: unknown): number | null {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows.length : null;
}

function wrapQuery(owner: QueryOwner, thresholdMs: number, log: (line: string) => void): void {
  const original = owner.query.bind(owner);
  owner.query = (...args: unknown[]) => {
    const startedAt = performance.now();
    const observe = (result: unknown): void => {
      const ms = performance.now() - startedAt;
      if (ms < thresholdMs) return;
      log(JSON.stringify({
        code: "AGENT_WORKFLOW_SLOW_QUERY",
        ms: Math.round(ms),
        rows: rowCount(result),
        statement: statementShape(args[0]),
      }));
    };
    const outcome = original(...args);
    // The callback form has no promise to observe; the pool contract keeps both.
    if (typeof (outcome as { then?: unknown } | null)?.then !== "function") return outcome;
    return (outcome as Promise<unknown>).then((result) => {
      observe(result);
      return result;
    }, (error: unknown) => {
      observe(null);
      throw error;
    });
  };
}

/** Wraps the pool and every client it hands out; wrapping twice is a no-op. */
export function traceWorkflowPool(
  pool: TraceablePool,
  thresholdMs: number = SLOW_QUERY_MS,
  log: (line: string) => void = (line) => console.warn(line),
): TraceablePool {
  const traced = pool as TraceablePool & { [TRACED]?: true };
  if (traced[TRACED] === true) return pool;
  traced[TRACED] = true;
  wrapQuery(pool, thresholdMs, log);
  const connect = pool.connect.bind(pool);
  pool.connect = (...args: unknown[]) => {
    const outcome = connect(...args);
    if (typeof (outcome as { then?: unknown } | null)?.then !== "function") return outcome;
    return (outcome as Promise<unknown>).then((client) => {
      const tracedClient = client as QueryOwner & { [TRACED]?: true };
      if (tracedClient !== null && typeof tracedClient?.query === "function" && tracedClient[TRACED] !== true) {
        tracedClient[TRACED] = true;
        wrapQuery(tracedClient, thresholdMs, log);
      }
      return client;
    });
  };
  return pool;
}
