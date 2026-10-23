/**
 * What the operator hears about the other families of the installation.
 *
 * Exports:
 * - `readOtherFamiliesHealth`: per family other than the operator's, counters of the daily failure signals that
 *   carry a family id.
 * - `formatOtherFamilies`: the digest block; nothing when the operator is alone.
 *
 * Key construct:
 * - The operator runs the service for other families but used to see only their own: a failing second family
 *   (sessions rotated after a failure, review batches that failed, a recurring reminder or schedule stopped by an
 *   error) reached nobody. Only counters and an ordinal reach the digest: no name, text, chat or person of that
 *   family, because the operator's digest lands in the operator's private chat. Ingress failures are installation-wide
 *   and stay in the operator's own block: a failed update has no family until it is processed.
 */
import { database } from "../database.js";
import { withSystemDatabaseContext } from "../database-context.js";

export interface OtherFamilyHealth {
  failedBatches: number;
  familyOrdinal: number;
  scheduleFailures: number;
  reminderFailures: number;
  rotations: number;
  since: Date;
}

export interface OtherFamiliesHealth {
  families: number;
  troubled: OtherFamilyHealth[];
}

export async function readOtherFamiliesHealth(operatorFamilyId: string, windowStart: Date): Promise<OtherFamiliesHealth> {
  // Ordinals follow the creation order, the operator's family being the first.
  const rows = await withSystemDatabaseContext(() => database().query<{
    created_at: Date; failed_batches: number; ordinal: string;
    reminders: number; rotations: number; schedules: number;
  }>(
    `SELECT f.created_at, f.ordinal::text,
            (SELECT count(*) FROM conversation_sessions s
              WHERE s.family_id = f.id AND s.rotation_requested_at >= $2
                AND s.rotation_reason IS DISTINCT FROM 'user_requested')::int AS rotations,
            (SELECT count(*) FROM memory_review_batches b
               JOIN application_conversations c ON c.id = b.conversation_id
              WHERE c.family_id = f.id AND b.created_at >= $2 AND b.status IN ('failed', 'ambiguous'))::int AS failed_batches,
            (SELECT count(*) FROM reminders r WHERE r.family_id = f.id AND r.status = 'failed')::int AS reminders,
            (SELECT count(*) FROM agent_schedules a WHERE a.family_id = f.id AND a.status = 'failed')::int AS schedules
       FROM (SELECT id, created_at, row_number() OVER (ORDER BY created_at, id) AS ordinal FROM families) f
      WHERE f.id <> $1
      ORDER BY f.ordinal LIMIT 50`,
    [operatorFamilyId, windowStart],
  ));
  const all = rows.rows.map((row) => ({
    failedBatches: row.failed_batches,
    familyOrdinal: Number(row.ordinal),
    reminderFailures: row.reminders,
    rotations: row.rotations,
    scheduleFailures: row.schedules,
    since: row.created_at,
  }));
  return {
    families: all.length,
    troubled: all.filter((item) => item.failedBatches + item.reminderFailures + item.rotations + item.scheduleFailures > 0),
  };
}

export function formatOtherFamilies(health: OtherFamiliesHealth): string | null {
  if (health.families === 0) return null;
  if (health.troubled.length === 0) return `Другие семьи: ${health.families}, сбоев нет.`;
  const lines = health.troubled.map((item) => {
    const parts = [
      item.rotations > 0 ? `сессий после сбоя ${item.rotations}` : null,
      item.failedBatches > 0 ? `упавших пакетов памяти ${item.failedBatches}` : null,
      item.reminderFailures > 0 ? `остановленных напоминаний ${item.reminderFailures}` : null,
      item.scheduleFailures > 0 ? `остановленных расписаний ${item.scheduleFailures}` : null,
    ].filter((part): part is string => part !== null);
    return `Семья ${item.familyOrdinal} (с ${item.since.toISOString().slice(0, 10)}): ${parts.join(", ")}.`;
  });
  return [`Другие семьи: ${health.families}, со сбоями ${health.troubled.length}.`, ...lines].join("\n");
}
