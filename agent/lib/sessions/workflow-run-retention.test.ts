/**
 * Finished turn run retention tests.
 *
 * Tests:
 * - Only old finished turn and session-timeout runs without retained hooks are selected.
 * - Each run is deleted in its own transaction, projections before the run row.
 * - A run whose status changed under the lock is skipped, and a failure rolls back and rethrows.
 * - One sweep keeps taking full batches until a batch comes back short or its time budget ends.
 */
import { describe, expect, it, vi } from "vitest";

import { pruneTerminalWorkflowRuns, pruneTerminalWorkflowRunsWithin } from "./workflow-run-retention.js";

function client(rows: Array<Record<string, unknown>[]>, failOn?: string) {
  // Only SELECTs consume scripted rows; BEGIN, DELETE and COMMIT answer with nothing.
  const query = vi.fn(async (text: string, _values?: readonly unknown[]) => {
    if (failOn && text.includes(failOn)) throw new Error("boom");
    return { rowCount: 1, rows: /^\s*SELECT/u.test(text) ? rows.shift() ?? [] : [] };
  });
  return { query };
}

describe("pruneTerminalWorkflowRuns", () => {
  it("selects old finished turn runs and deletes each in its own transaction", async () => {
    const c = client([[{ id: "wrun_A" }, { id: "wrun_B" }], [{ status: "completed" }], [{ status: "cancelled" }]]);
    expect(await pruneTerminalWorkflowRuns(c, { batch: 10, retentionDays: 7 })).toBe(2);
    const [selectText, selectValues] = c.query.mock.calls[0]!;
    expect(selectText).toContain("token_retention_until");
    expect(selectText).toContain("make_interval(days => $2::int)");
    expect(selectValues).toEqual([["workflow//eve//turnWorkflow", "workflow//eve//sessionTimeoutWorkflow"], 7, 10]);
    const texts = c.query.mock.calls.map((call) => call[0]);
    expect(texts.filter((t) => t === "BEGIN")).toHaveLength(2);
    expect(texts.filter((t) => t === "COMMIT")).toHaveLength(2);
    // BEGIN, the lock, seven per-run deletions, the run itself, COMMIT.
    const firstRun = texts.slice(1, 12);
    expect(firstRun[0]).toBe("BEGIN");
    expect(firstRun[1]).toContain("FOR UPDATE");
    expect(firstRun).toContain("DELETE FROM workflow.workflow_payload_blob_refs WHERE run_id = $1");
    expect(firstRun[firstRun.length - 2]).toBe("DELETE FROM workflow.workflow_runs WHERE id = $1");
    expect(firstRun[firstRun.length - 1]).toBe("COMMIT");
    // Blobs nobody refers to any more go after the runs, once per sweep.
    expect(texts.at(-1)).toContain("DELETE FROM workflow.workflow_payload_blobs");
  });

  it("skips a run that is no longer finished under the lock", async () => {
    const c = client([[{ id: "wrun_A" }], [{ status: "running" }]]);
    expect(await pruneTerminalWorkflowRuns(c)).toBe(0);
    expect(c.query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it("rolls back and rethrows a failed deletion", async () => {
    const c = client([[{ id: "wrun_A" }], [{ status: "completed" }]], "workflow_steps");
    await expect(pruneTerminalWorkflowRuns(c)).rejects.toThrow("boom");
    expect(c.query).toHaveBeenLastCalledWith("ROLLBACK");
  });
});

describe("pruneTerminalWorkflowRunsWithin", () => {
  // One run selected per batch, then its locked status: a full batch of one.
  const fullBatch = () => [[{ id: "wrun_X" }], [{ status: "completed" }]];

  it("keeps sweeping while batches come back full", async () => {
    const c = client([...fullBatch(), ...fullBatch(), []]);
    expect(await pruneTerminalWorkflowRunsWithin(c, { batch: 1, budgetMs: 60_000 })).toBe(2);
    expect(c.query.mock.calls.filter((call) => /^\s*SELECT r\.id/u.test(call[0])).length).toBe(3);
  });

  it("stops at its time budget even with more to delete", async () => {
    const c = client([...fullBatch(), ...fullBatch(), ...fullBatch()]);
    let now = 0;
    const clock = () => (now += 10_000);
    expect(await pruneTerminalWorkflowRunsWithin(c, { batch: 1, budgetMs: 15_000, clock })).toBe(1);
  });
});
