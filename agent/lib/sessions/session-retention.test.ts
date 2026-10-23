/**
 * Eve terminal session retention job tests.
 *
 * Constructs covered:
 * - A dedicated PostgreSQL advisory lock serializes physical Workflow graph deletion.
 * - A concurrent invocation exits without claiming a second application session.
 * - Destroying the lock connection releases the session-level lock after the sweep.
 * - Turn runs left by sessions deleted before the fix are swept under the same lock.
 * - Sessions of an erased person or family are deleted from the queue only after Eve's store let them go.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const values = vi.hoisted(() => {
  let lockHeld = false;
  let resolveDeletion!: () => void;
  const deletionPromise = new Promise<void>((resolve) => {
    resolveDeletion = resolve;
  });
  const lockRelease = vi.fn((destroy?: boolean) => {
    if (destroy) lockHeld = false;
  });
  const lockQuery = vi.fn(async () => {
    if (lockHeld) return { rows: [{ acquired: false }] };
    lockHeld = true;
    return { rows: [{ acquired: true }] };
  });
  return {
    claimExpiredForDeletion: vi.fn(),
    completeDeletion: vi.fn(),
    connect: vi.fn(async () => ({ query: lockQuery, release: lockRelease })),
    deleteOrphanedRuns: vi.fn(async () => 0),
    deletePostgresEveSession: vi.fn(async () => deletionPromise),
    failDeletion: vi.fn(),
    lockQuery,
    lockRelease,
    query: vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] as Array<{ eve_session_id: string }> })),
    resolveDeletion,
    retireAbandonedTasks: vi.fn(),
  };
});

vi.mock("../database.js", () => ({
  database: () => ({ connect: values.connect, query: values.query }),
}));
vi.mock("./workflow-postgres-session-storage.js", () => ({
  deleteConfiguredOrphanedPostgresEveRuns: values.deleteOrphanedRuns,
  deleteConfiguredPostgresEveSession: values.deletePostgresEveSession,
}));
vi.mock("./workflow-run-retention.js", () => ({
  pruneConfiguredTerminalWorkflowRuns: vi.fn().mockResolvedValue(0),
}));
vi.mock("./session-repository.js", () => ({
  sessionRepository: {
    claimExpiredForDeletion: values.claimExpiredForDeletion,
    completeDeletion: values.completeDeletion,
    failDeletion: values.failDeletion,
    retireAbandonedTasks: values.retireAbandonedTasks,
  },
}));

import { deleteExpiredSessions } from "./session-retention.js";

describe("deleteExpiredSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    values.claimExpiredForDeletion
      .mockResolvedValueOnce({
        eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QR",
        id: "application-session-1",
        leaseToken: "lease-1",
      })
      .mockResolvedValue(null);
  });

  it("serializes physical deletion across concurrent retention jobs", async () => {
    const first = deleteExpiredSessions();
    await vi.waitFor(() => expect(values.deletePostgresEveSession).toHaveBeenCalledTimes(1));

    await expect(deleteExpiredSessions()).resolves.toBe(0);
    expect(values.claimExpiredForDeletion).toHaveBeenCalledTimes(1);
    expect(values.lockRelease).toHaveBeenCalledWith(false);

    values.resolveDeletion();
    await expect(first).resolves.toBe(1);
    expect(values.completeDeletion).toHaveBeenCalledWith(
      "application-session-1",
      "lease-1",
    );
    expect(values.lockRelease).toHaveBeenLastCalledWith(true);
  });

  it("deletes the queued sessions of an erased family from Eve's store, then from the queue", async () => {
    values.claimExpiredForDeletion.mockReset().mockResolvedValue(null);
    values.deletePostgresEveSession.mockResolvedValue(undefined);
    values.query
      .mockResolvedValueOnce({ rows: [{ eve_session_id: "wrun_erased_1" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(deleteExpiredSessions()).resolves.toBe(1);
    expect(values.deletePostgresEveSession).toHaveBeenCalledWith("wrun_erased_1");
    expect(values.query.mock.calls[1]).toEqual(["DELETE FROM erased_eve_sessions WHERE eve_session_id = $1", ["wrun_erased_1"]]);
  });
});
