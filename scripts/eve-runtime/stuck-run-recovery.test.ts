/**
 * Stuck run recovery scheduling tests.
 *
 * Constructs covered:
 * - Each found run is enqueued on its workflow's queue with only its run id, as startup recovery does.
 * - A failing scan is logged and the next scan still runs; scans never overlap.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { releaseDeadWorkerLocks, startStuckRunRecovery } from "./stuck-run-recovery.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("stuck run recovery scheduling", () => {
  it("enqueues every stuck run on its workflow queue", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const enqueue = vi.fn(async () => ({}));
    const pool = { query: vi.fn(async () => ({ rows: [{ last_event: "step_retrying", run_id: "wrun_a", workflow_name: "workflow//eve//turnWorkflow" }] })) };
    const stop = startStuckRunRecovery({ enqueue, intervalMs: 1000, pool, queuePrefix: "__wkf_workflow_" });

    await vi.advanceTimersByTimeAsync(1000);
    stop();

    expect(enqueue).toHaveBeenCalledWith("__wkf_workflow_workflow//eve//turnWorkflow", { runId: "wrun_a" });
  });

  it("logs a failed scan and keeps scanning", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = { query: vi.fn(async () => { throw new Error("connection reset"); }) };
    const stop = startStuckRunRecovery({ enqueue: vi.fn(), intervalMs: 1000, pool, queuePrefix: "p_" });

    await vi.advanceTimersByTimeAsync(2000);
    stop();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0]?.[0]).toContain("AGENT_WORKFLOW_STUCK_RUN_SCAN_FAILED");
  });
});

describe("releaseDeadWorkerLocks", () => {
  it("frees the locks older than this process's start and reports how many workers held them", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool = { query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: [{ workers: "2" }] };
    } };
    const startedAt = new Date("2026-10-05T14:31:57Z");
    await expect(releaseDeadWorkerLocks(pool, startedAt)).resolves.toBe(2);
    expect(queries[0]!.values).toEqual([startedAt]);
    expect(queries[0]!.text).toContain("graphile_worker.force_unlock_workers");
    expect(queries[0]!.text).toContain("_private_job_queues");
  });
});
