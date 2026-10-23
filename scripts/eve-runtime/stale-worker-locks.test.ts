/** Startup release of queue locks older than this process: the SQL condition and its report. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { releaseStaleWorkerLocks } from "./stale-worker-locks.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("releaseStaleWorkerLocks", () => {
  it("frees only locks taken before this process's start, on jobs and job queues, and reports the workers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool = { query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: [{ workers: "2" }] };
    } };
    const startedAt = new Date("2026-10-05T14:31:57Z");

    await expect(releaseStaleWorkerLocks(pool, startedAt)).resolves.toBe(2);

    expect(queries).toHaveLength(1);
    expect(queries[0]!.values).toEqual([startedAt]);
    const sql = queries[0]!.text;
    expect(sql).toContain('"graphile_worker".force_unlock_workers');
    expect(sql).toContain('"graphile_worker"._private_jobs');
    expect(sql).toContain('"graphile_worker"._private_job_queues');
    // Both lock tables use the same strict bound: a lock at or after the start is this process's own.
    expect(sql.match(/locked_by IS NOT NULL AND locked_at < \$1/g)).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({ code: "AGENT_WORKFLOW_STALE_WORKER_LOCKS_RELEASED", workers: 2 });
  });

  it("stays silent when nothing was locked by a dead worker", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pool = { query: async () => ({ rows: [{ workers: "0" }] }) };

    await expect(releaseStaleWorkerLocks(pool, new Date())).resolves.toBe(0);

    expect(warn).not.toHaveBeenCalled();
  });

  it("quotes a custom schema and rejects one that is not an identifier", async () => {
    const pool = { query: vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [] as Record<string, unknown>[] })) };

    await expect(releaseStaleWorkerLocks(pool, new Date(), "recovery_abc")).resolves.toBe(0);
    expect(pool.query.mock.calls[0]![0]).toContain('"recovery_abc".force_unlock_workers');

    await expect(releaseStaleWorkerLocks(pool, new Date(), 'x"; drop schema')).rejects.toThrow("AGENT_WORKFLOW_SCHEMA_INVALID");
    expect(pool.query).toHaveBeenCalledOnce();
  });
});
