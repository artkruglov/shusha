/**
 * Durable side of the session handoff: the summary a new session inherits from the one the turn
 * limit retired (migration 198).
 *
 * Exports:
 * - `sessionHandoffRepository.store`: writes the summary with its size and latency on the active
 *   session; a retired one is reported, never written.
 * - `sessionHandoffRepository.read`: the summary of an active session while no turn has shown it.
 * - `sessionHandoffRepository.markShown`: called once a turn's durable message carries it, so a
 *   preparation that fails before that point leaves the summary for the next turn.
 */
import { database } from "../database.js";

export interface SessionHandoffRecord {
  latencyMs: number;
  sourceEntries: number;
  text: string;
}

export type SessionHandoffStoreResult = "session_retired" | "stored";

export const sessionHandoffRepository = {
  async markShown(applicationSessionId: string): Promise<void> {
    await database().query(
      `UPDATE conversation_sessions
          SET handoff_shown_at = coalesce(handoff_shown_at, now())
        WHERE id = $1 AND handoff_text IS NOT NULL`,
      [applicationSessionId],
    );
  },

  async read(applicationSessionId: string): Promise<string | null> {
    const result = await database().query<{ handoff_text: string }>(
      `SELECT handoff_text FROM conversation_sessions
        WHERE id = $1 AND retired_at IS NULL AND handoff_text IS NOT NULL AND handoff_shown_at IS NULL`,
      [applicationSessionId],
    );
    return result.rows[0]?.handoff_text ?? null;
  },

  async store(applicationSessionId: string, record: SessionHandoffRecord): Promise<SessionHandoffStoreResult> {
    const result = await database().query(
      `UPDATE conversation_sessions
          SET handoff_text = $2, handoff_generated_at = now(), handoff_shown_at = NULL,
              handoff_latency_ms = $3, handoff_source_entries = $4
        WHERE id = $1 AND retired_at IS NULL`,
      [applicationSessionId, record.text, record.latencyMs, record.sourceEntries],
    );
    return result.rowCount === 1 ? "stored" : "session_retired";
  },
};
