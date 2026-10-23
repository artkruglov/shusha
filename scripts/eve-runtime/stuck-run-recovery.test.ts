/**
 * Stuck run recovery scheduling tests.
 *
 * Constructs covered:
 * - Each found run is enqueued on its workflow's queue with only its run id, as startup recovery does.
 * - A failing scan is logged and the next scan still runs; scans never overlap.
 * - Startup recovery asks only for the runs interrupted mid-flight, pages them by run id and
 *   enqueues each on its workflow queue; the SQL conditions themselves run in the integration test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findInFlightRuns,
  INFLIGHT_COMPLETED_STEP_WITHIN_MS,
  releaseDeadWorkerLocks,
  requeueInFlightRuns,
  startStuckRunRecovery,
} from "./stuck-run-recovery.ts";

function row(runId: string, lastEvent = "step_started") {
  return { last_event: lastEvent, run_id: runId, workflow_name: "workflow//eve//turnWorkflow" };
}

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

describe("findInFlightRuns", () => {
  it("excludes parked and sleeping runs and old completed steps that still hold a hook", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    await expect(findInFlightRuns(pool)).resolves.toEqual([]);
    const [text, values] = pool.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(text).toContain("r.status IN ('pending', 'running')");
    expect(text).toContain("last.type <> ALL($2::text[])");
    expect(text).toContain("last.type <> 'step_completed'");
    expect(text).toContain("NOT EXISTS (SELECT 1 FROM workflow.workflow_hooks h WHERE h.run_id = r.id)");
    expect(text).toContain("ORDER BY r.id");
    expect(values).toEqual(["", ["hook_created", "wait_created"], 500, INFLIGHT_COMPLETED_STEP_WITHIN_MS / 1000]);
    expect(INFLIGHT_COMPLETED_STEP_WITHIN_MS).toBe(10 * 60 * 1000);
  });

  it("pages by run id until a short page and skips malformed rows", async () => {
    const pages = [
      { rows: [row("wrun_a"), row("wrun_b", "step_retrying")] },
      { rows: [row("wrun_c"), { run_id: null, workflow_name: "w", last_event: "x" }] },
      { rows: [row("wrun_d")] },
    ];
    const pool = { query: vi.fn(async () => pages.shift() ?? { rows: [] }) };

    const found = await findInFlightRuns(pool, 2);

    expect(found.map((run) => run.runId)).toEqual(["wrun_a", "wrun_b", "wrun_c", "wrun_d"]);
    expect(found[1]).toEqual({ lastEvent: "step_retrying", runId: "wrun_b", workflowName: "workflow//eve//turnWorkflow" });
    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(pool.query.mock.calls.map((call) => (call as unknown as [string, unknown[]])[1][0])).toEqual(["", "wrun_b", "wrun_c"]);
    expect(pool.query.mock.calls.every((call) => (call as unknown as [string, unknown[]])[1][2] === 2)).toBe(true);
  });
});

describe("requeueInFlightRuns", () => {
  it("enqueues each interrupted run on its workflow queue and reports the count once", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const enqueue = vi.fn(async () => ({}));
    const pool = { query: vi.fn(async () => ({ rows: [row("wrun_a"), row("wrun_b", "run_created")] })) };

    await expect(requeueInFlightRuns({ enqueue, pool, queuePrefix: "__wkf_workflow_" })).resolves.toBe(2);

    expect(enqueue.mock.calls).toEqual([
      ["__wkf_workflow_workflow//eve//turnWorkflow", { runId: "wrun_a" }],
      ["__wkf_workflow_workflow//eve//turnWorkflow", { runId: "wrun_b" }],
    ]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(info.mock.calls[0]![0] as string)).toEqual({ code: "AGENT_WORKFLOW_INFLIGHT_RUNS_REQUEUED", count: 2 });
  });

  it("is silent when nothing was interrupted", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const enqueue = vi.fn(async () => ({}));
    const pool = { query: vi.fn(async () => ({ rows: [] })) };

    await expect(requeueInFlightRuns({ enqueue, pool, queuePrefix: "p_" })).resolves.toBe(0);

    expect(enqueue).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
