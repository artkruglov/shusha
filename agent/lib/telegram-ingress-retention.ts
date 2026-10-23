/**
 * Retention of the durable Telegram ingress queue.
 *
 * Export:
 * - `purgeCompletedTelegramUpdates`: deletes completed updates older than the retention window,
 *   and failed guest updates and empty guest and button-press queues of the same age, one bounded
 *   batch per call.
 *
 * Key construct:
 * - Every update was kept forever with its full raw payload, including messages of people who
 *   are not family members (security review, 5 October 2026: 26 625 rows since 2 September).
 *   Deduplication by `update_id` needs a row only while Telegram may redeliver it (24 hours), so
 *   a completed update older than the window is only data. Failed updates are kept: they are
 *   what the owner's digest and a diagnosis read. Interjection rows go with their update by
 *   cascade.
 * - A guest message is a stranger's chat quoted to the bot. Its failure has no owner digest to feed,
 *   so it is deleted on the same window as a completed one; each guest query had a queue of its own,
 *   and an emptied guest queue is deleted with its aliases. A press on a button under an inline or
 *   guest answer has no message and gets a queue of its own too («Напомнить и мне»), so those go
 *   the same way once empty.
 */
import { TELEGRAM_INGRESS_PURGE_BATCH_SIZE, TELEGRAM_INGRESS_RETENTION_DAYS } from "../config.js";
import { database } from "./database.js";

export async function purgeCompletedTelegramUpdates(
  now: Date,
  batchSize: number = TELEGRAM_INGRESS_PURGE_BATCH_SIZE,
): Promise<number> {
  const result = await database().query(
    `WITH expired AS (
       SELECT update_id
         FROM telegram_ingress_updates
        WHERE (status = 'completed' AND completed_at <= $1::timestamptz - ($2::integer * interval '1 day'))
           OR (status = 'failed' AND ingress_continuation_key LIKE 'telegram:guest:%'
               AND updated_at <= $1::timestamptz - ($2::integer * interval '1 day'))
        ORDER BY COALESCE(completed_at, updated_at)
        LIMIT $3::integer
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM telegram_ingress_updates update_row
      USING expired
      WHERE update_row.update_id = expired.update_id`,
    [now, TELEGRAM_INGRESS_RETENTION_DAYS, batchSize],
  );
  const deletedCount = result.rowCount ?? 0;
  await database().query(
    `DELETE FROM telegram_ingress_queues queue
      WHERE queue.id IN (
        SELECT candidate.id FROM telegram_ingress_queues candidate
         WHERE (candidate.current_continuation_key LIKE 'telegram:guest:%'
                OR candidate.current_continuation_key LIKE 'telegram:callback:%')
           AND candidate.created_at <= $1::timestamptz - ($2::integer * interval '1 day')
           AND NOT EXISTS (SELECT 1 FROM telegram_ingress_updates update_row WHERE update_row.queue_id = candidate.id)
         LIMIT $3::integer
      )`,
    [now, TELEGRAM_INGRESS_RETENTION_DAYS, batchSize],
  );
  if (deletedCount > 0) {
    console.info(JSON.stringify({
      batchLimitReached: deletedCount === batchSize,
      code: "AGENT_TELEGRAM_INGRESS_PURGE_COMPLETED",
      deletedCount,
    }));
  }
  return deletedCount;
}
