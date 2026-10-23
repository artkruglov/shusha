/**
 * Slow-query trace for the application PostgreSQL pool.
 *
 * Exports:
 * - `traceSlowQueries`: wraps a pool so a query over the threshold reports itself once.
 *
 * Key construct:
 * - Finding where a turn spends its time meant switching `log_min_duration_statement` on in
 *   production and waiting for a live message (10 сентября 2026). A query slower than the
 *   threshold now names itself in the ordinary log instead.
 * - Only the statement shape is logged, never parameter values: they carry family chat text,
 *   memory content and Telegram identity.
 */
import type { Pool, PoolClient } from "pg";

export interface SlowQueryTrace {
  readonly code: string;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  readonly thresholdMs: number;
}

const TRACED = Symbol.for("osinara.slowQueryTrace");
const STATEMENT_LOG_LIMIT = 120;

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

/** Wraps `query` on the pool and on every checked-out client; wrapping twice is a no-op. */
export function traceSlowQueries<T extends Pool>(pool: T, trace: SlowQueryTrace): T {
  const traced = pool as T & { [TRACED]?: true };
  if (traced[TRACED] === true) return pool;
  traced[TRACED] = true;
  const now = trace.now ?? (() => performance.now());
  const log = trace.log ?? ((line: string) => console.warn(line));

  const observe = (query: unknown, startedAt: number, result: unknown): void => {
    const ms = now() - startedAt;
    if (ms < trace.thresholdMs) return;
    log(JSON.stringify({
      code: trace.code,
      ms: Math.round(ms),
      rows: rowCount(result),
      statement: statementShape(query),
    }));
  };

  const wrapQuery = <O extends { query: (...args: never[]) => unknown }>(owner: O): void => {
    const original = owner.query.bind(owner) as (...args: unknown[]) => unknown;
    owner.query = ((...args: unknown[]) => {
      const startedAt = now();
      const outcome = original(...args);
      // The callback form has no promise to observe; the pool contract keeps both.
      if (typeof (outcome as { then?: unknown } | null)?.then !== "function") return outcome;
      return (outcome as Promise<unknown>).then((result) => {
        observe(args[0], startedAt, result);
        return result;
      }, (error: unknown) => {
        observe(args[0], startedAt, null);
        throw error;
      });
    }) as O["query"];
  };

  wrapQuery(pool as unknown as { query: (...args: never[]) => unknown });
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  pool.connect = ((...args: unknown[]) => {
    const outcome = connect(...args);
    // `connect` keeps both the promise and the callback form; the callback one returns nothing.
    if (typeof (outcome as { then?: unknown } | null)?.then !== "function") return outcome;
    return (outcome as Promise<PoolClient>).then((client) => {
      const tracedClient = client as PoolClient & { [TRACED]?: true };
      if (tracedClient[TRACED] !== true) {
        tracedClient[TRACED] = true;
        wrapQuery(client as unknown as { query: (...args: never[]) => unknown });
      }
      return client;
    });
  }) as T["connect"];
  return pool;
}
