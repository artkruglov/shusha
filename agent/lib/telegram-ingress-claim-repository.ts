/**
 * Lease claims of the durable Telegram ingress: the FIFO head, the private-chat burst hold and the
 * series run behind a leased head.
 *
 * Export:
 * - `telegramIngressClaimRepository`: `claimNext`, `heldPrivateChatReadyIn`, `claimFollowing`,
 *   spread into `telegramIngressRepository`.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import {
  type ClaimRow,
  mapTelegramIngressClaim,
  NO_PRIVATE_BURST,
  requireLeaseMilliseconds,
  requireUpdateId,
  type TelegramIngressRepository,
  type TelegramPrivateBurstPolicy,
} from "./telegram-ingress-contract.js";
import { RETIRED_INGRESS_CHAT_SQL, retireMigratedChatIngress } from "./telegram-group-migration/retire-ingress.js";

function requirePrivateBurstPolicy(burst: TelegramPrivateBurstPolicy): void {
  const { maxWaitMilliseconds, quietMilliseconds } = burst;
  if (![maxWaitMilliseconds, quietMilliseconds].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    maxWaitMilliseconds < quietMilliseconds) {
    throw new AppError("AGENT_TELEGRAM_BURST_WINDOW_INVALID", "Пауза перед ответом в личном чате задана неверно");
  }
}

export const telegramIngressClaimRepository: Pick<
  TelegramIngressRepository,
  "claimFollowing" | "claimNext" | "heldPrivateChatReadyIn"
> = {
  async claimNext(leaseMilliseconds, options) {
    requireLeaseMilliseconds(leaseMilliseconds);
    const burst = options?.burst ?? NO_PRIVATE_BURST;
    requirePrivateBurstPolicy(burst);
    await retireMigratedChatIngress();
    // The anti-join makes every non-terminal earlier update a hard FIFO barrier for its queue.
    // A private chat still receiving a burst is left alone until it has been quiet for the window,
    // or the cap has passed since its head arrived; only a pending message waits, never a retry.
    // A button press has no message and must compare as not private, never as unknown.
    const result = await database().query<ClaimRow>(
      `WITH candidate AS (
         SELECT item.update_id
         FROM telegram_ingress_updates item
         WHERE (item.status = 'pending'
             OR (item.status = 'processing' AND item.lease_expires_at <= now()))
           AND NOT (${RETIRED_INGRESS_CHAT_SQL})
           -- Guest answers are one bounded model call, as short as a press, so they share its pool; a join
           -- greeting has five minutes to reach the person, so it does too.
           AND ($2::boolean = false OR item.payload ? 'callback_query' OR item.payload ? 'guest_message'
             OR item.payload ? 'chat_join_request')
           AND NOT EXISTS (
             SELECT 1
             FROM telegram_ingress_updates earlier
             WHERE earlier.queue_id = item.queue_id
               AND earlier.update_id < item.update_id
                AND earlier.status IN ('pending', 'processing')
           )
           AND NOT (item.status = 'pending' AND $3::bigint > 0
             AND (item.payload #>> '{message,chat,type}') IS NOT DISTINCT FROM 'private'
             -- A command (/stop, /start code) never waits for a burst that is not its own.
             AND COALESCE(item.payload #>> '{message,text}', '') NOT LIKE '/%'
             AND item.received_at > now() - ($4 * interval '1 millisecond')
             AND EXISTS (
               SELECT 1 FROM telegram_ingress_updates latest
                WHERE latest.queue_id = item.queue_id AND latest.status = 'pending' AND latest.payload ? 'message'
                  AND latest.received_at > now() - ($3 * interval '1 millisecond')
             ))
         ORDER BY item.update_id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE telegram_ingress_updates item
       SET status = 'processing',
           attempt_count = attempt_count + 1,
           lease_token = gen_random_uuid(),
           lease_expires_at = now() + ($1 * interval '1 millisecond'),
           last_error_code = NULL,
           last_error_message = NULL,
           updated_at = now()
       FROM candidate, telegram_ingress_queues queue
       WHERE item.update_id = candidate.update_id
         AND queue.id = item.queue_id
       RETURNING item.update_id::text, item.queue_id, item.ingress_continuation_key,
         item.payload, item.attempt_count, item.lease_token::text, item.lease_expires_at,
         item.voice_file_id, item.voice_file_size::text, item.voice_mime_type,
         item.voice_transcript, queue.current_continuation_key`,
      [leaseMilliseconds, options?.callbackOnly === true, burst.quietMilliseconds, burst.maxWaitMilliseconds],
    );
    return result.rows[0] ? mapTelegramIngressClaim(result.rows[0]) : null;
  },

  async heldPrivateChatReadyIn(burst) {
    requirePrivateBurstPolicy(burst);
    if (burst.quietMilliseconds === 0) return null;
    // The same moment the claim condition waits for: quiet since the newest message, or the cap
    // counted from the head.
    const result = await database().query<{ wait: string | null }>(
      `SELECT ceil(extract(epoch FROM min(ready_at) - clock_timestamp()) * 1000)::bigint::text AS wait
         FROM (
           SELECT LEAST(max(held.received_at) + ($1 * interval '1 millisecond'),
                        min(held.received_at) + ($2 * interval '1 millisecond')) AS ready_at
             FROM telegram_ingress_updates held
            WHERE held.status = 'pending' AND (held.payload #>> '{message,chat,type}') IS NOT DISTINCT FROM 'private'
              -- A chat whose head is already being worked on is not held: its tail waits for that turn.
              AND NOT EXISTS (
                SELECT 1 FROM telegram_ingress_updates busy
                 WHERE busy.queue_id = held.queue_id AND busy.status = 'processing')
            GROUP BY held.queue_id
         ) held
        WHERE ready_at > clock_timestamp()`,
      [burst.quietMilliseconds, burst.maxWaitMilliseconds],
    );
    const wait = result.rows[0]?.wait;
    return wait === null || wait === undefined ? null : Math.max(0, Number(wait));
  },

  async claimFollowing(input) {
    requireLeaseMilliseconds(input.leaseMilliseconds);
    requireUpdateId(input.afterUpdateId);
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) return [];
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // The head of this queue is leased by the caller, so every later item is still pending;
      // the row locks keep a concurrent drain from interleaving a claim into the run.
      const candidates = await client.query<{
        payload: Record<string, unknown>;
        update_id: string;
        voice_file_id: string | null;
      }>(
        `SELECT update_id::text, payload, voice_file_id
         FROM telegram_ingress_updates
         WHERE queue_id = $1 AND update_id > $2::bigint AND status = 'pending'
         ORDER BY update_id
         LIMIT $3
         FOR UPDATE`,
        [input.queueId, input.afterUpdateId, input.limit],
      );
      const accepted: string[] = [];
      for (const candidate of candidates.rows) {
        if (candidate.voice_file_id !== null || !input.accept(candidate.payload)) break;
        accepted.push(candidate.update_id);
      }
      if (accepted.length === 0) {
        await client.query("COMMIT");
        return [];
      }
      const claimed = await client.query<ClaimRow>(
        `WITH claimed AS (
           UPDATE telegram_ingress_updates item
           SET status = 'processing',
               attempt_count = attempt_count + 1,
               lease_token = gen_random_uuid(),
               lease_expires_at = now() + ($2 * interval '1 millisecond'),
               last_error_code = NULL,
               last_error_message = NULL,
               updated_at = now()
           WHERE item.update_id = ANY($1::bigint[]) AND item.status = 'pending'
           RETURNING item.*
         )
         SELECT claimed.update_id::text, claimed.queue_id, claimed.ingress_continuation_key,
           claimed.payload, claimed.attempt_count, claimed.lease_token::text,
           claimed.lease_expires_at, claimed.voice_file_id, claimed.voice_file_size::text,
           claimed.voice_mime_type, claimed.voice_transcript, queue.current_continuation_key
         FROM claimed
         JOIN telegram_ingress_queues queue ON queue.id = claimed.queue_id
         ORDER BY claimed.update_id`,
        [accepted, input.leaseMilliseconds],
      );
      if (claimed.rowCount !== accepted.length) {
        throw new AppError(
          "AGENT_TELEGRAM_SERIES_CLAIM_FAILED",
          "Не удалось захватить серию сообщений Telegram целиком",
        );
      }
      await client.query("COMMIT");
      return claimed.rows.map(mapTelegramIngressClaim);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
