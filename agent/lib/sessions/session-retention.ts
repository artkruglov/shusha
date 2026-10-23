/**
 * PostgreSQL Workflow session retention job boundary.
 *
 * Export:
 * - `deleteExpiredSessions`: globally serializes, leases, and physically deletes retired Eve sessions, and the
 *   sessions of an erased person or family queued in `erased_eve_sessions` (migration 183).
 */
import { isAppError } from "../app-error.js";
import { database } from "../database.js";
import { sessionRepository } from "./session-repository.js";
import {
  deleteConfiguredOrphanedPostgresEveRuns,
  deleteConfiguredPostgresEveSession,
} from "./workflow-postgres-session-storage.js";
import { pruneConfiguredTerminalWorkflowRuns } from "./workflow-run-retention.js";

const SESSION_RETENTION_ADVISORY_LOCK_KEY = "osinara-eve-session-retention";

export async function deleteExpiredSessions(): Promise<number> {
  // Per-session leases allow parallel workers, but world-local hook indexes are shared across runs.
  // Hold one dedicated connection for the complete physical sweep and destroy it to release the lock
  // even when filesystem cleanup throws before PostgreSQL can be contacted again.
  const lockClient = await database().connect();
  let acquired = false;
  try {
    const lock = await lockClient.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [SESSION_RETENTION_ADVISORY_LOCK_KEY],
    );
    acquired = lock.rows[0]?.acquired === true;
    if (!acquired) return 0;

    return await deleteExpiredSessionsUnderLock();
  } finally {
    lockClient.release(acquired);
  }
}

async function deleteExpiredSessionsUnderLock(): Promise<number> {
  // The existing minute lifecycle hook bounds abandoned task rows before physical Eve deletion.
  await sessionRepository.retireAbandonedTasks(new Date());
  // Finished per-turn runs outlive their sessions otherwise (ilkruglov b6dc69d1, 3266a62a); the same lock serializes both sweeps.
  await pruneConfiguredTerminalWorkflowRuns();
  // Ходы сессий, удалённых до того, как удаление стало забирать их с собой, звать больше некому.
  const orphans = await deleteConfiguredOrphanedPostgresEveRuns();
  if (orphans > 0) {
    console.error(JSON.stringify({ code: "AGENT_EVE_ORPHAN_RUNS_DELETED", runs: orphans }));
  }
  let deleted = await deleteErasedSessions();
  while (true) {
    const claim = await sessionRepository.claimExpiredForDeletion(new Date());
    if (!claim) return deleted;

    try {
      await deleteConfiguredPostgresEveSession(claim.eveSessionId);
      await sessionRepository.completeDeletion(claim.id, claim.leaseToken);
      deleted += 1;
    } catch (error) {
      const errorCode = isAppError(error) ? error.code : "AGENT_SESSION_RETENTION_DELETE_FAILED";
      // Workflow no longer holds the run, so there is nothing left to delete there and the
      // application row would otherwise wait for storage that will never answer.
      if (errorCode === "AGENT_EVE_SESSION_STORAGE_MISSING") {
        await sessionRepository.completeDeletion(claim.id, claim.leaseToken);
        deleted += 1;
        console.info(JSON.stringify({
          applicationSessionId: claim.id,
          code: "AGENT_SESSION_RETENTION_STORAGE_ABSENT",
          eveSessionId: claim.eveSessionId,
        }));
        continue;
      }
      // This schedule is the boundary: persist the context (the row gets its retry moment) and
      // keep sweeping. Rethrowing left every later expired session untouched for the minute.
      await sessionRepository.failDeletion(claim.id, claim.leaseToken, errorCode, new Date());
      console.error(JSON.stringify({
        applicationSessionId: claim.id,
        code: "AGENT_SESSION_RETENTION_DELETE_FAILED",
        error: error instanceof Error ? error.message : String(error),
        errorCode,
        eveSessionId: claim.eveSessionId,
      }));
    }
  }
}

/**
 * Sessions of an erased person or family: their application rows are already gone, so the queue holds only the
 * Eve id. A failed deletion keeps its row for the next sweep and stops this one, like any retention failure.
 */
async function deleteErasedSessions(): Promise<number> {
  let deleted = 0;
  while (true) {
    const next = await database().query<{ eve_session_id: string }>(
      "SELECT eve_session_id FROM erased_eve_sessions ORDER BY erased_at, eve_session_id LIMIT 1",
    );
    const eveSessionId = next.rows[0]?.eve_session_id;
    if (eveSessionId === undefined) return deleted;
    try {
      await deleteConfiguredPostgresEveSession(eveSessionId);
    } catch (error) {
      console.error(JSON.stringify({
        code: "AGENT_ERASED_SESSION_DELETE_FAILED",
        errorCode: isAppError(error) ? error.code : "AGENT_SESSION_RETENTION_DELETE_FAILED",
      }));
      throw error;
    }
    await database().query("DELETE FROM erased_eve_sessions WHERE eve_session_id = $1", [eveSessionId]);
    deleted += 1;
  }
}
