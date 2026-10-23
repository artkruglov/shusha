/**
 * One alert to the owner when a Telegram message is stuck in processing.
 *
 * Exports:
 * - `TELEGRAM_INGRESS_STALL_ALERT_AFTER_MS`: how long a dispatched message may stay unanswered.
 * - `claimStalledIngress`: marks and returns messages that crossed it and were not alerted yet.
 * - `dispatchIngressStallAlerts`: tells each owner, once per message.
 *
 * Key construct:
 * - On 2 October 2026 a private message stayed `processing` for 8.5 hours behind a turn whose step
 *   had lost its retry job; its lease kept being renewed, so nothing looked wrong. Workflow's
 *   stuck-run scan now re-enqueues such runs within 10–25 minutes; this alert is for what it misses.
 * - The claim is written before sending: a crash after the claim loses that one alert rather than
 *   repeating it every tick.
 */
import { database } from "./database.js";
import { readTelegramAgentIdentity } from "./telegram-agent-identity.js";
import { ownerHealthDigestRepository, type OwnerHealthRecipient } from "./health/owner-health-digest-repository.js";
import { memoryReviewOwnerAlertTransport } from "./memory-review/memory-review-owner-alert-transport.js";

export const TELEGRAM_INGRESS_STALL_ALERT_AFTER_MS = 30 * 60 * 1000;

export interface StalledIngress {
  chatType: string;
  receivedAt: Date;
  updateId: string;
}

export async function claimStalledIngress(
  stallAfterMs: number = TELEGRAM_INGRESS_STALL_ALERT_AFTER_MS,
): Promise<StalledIngress[]> {
  const result = await database().query<{ chat_type: string | null; received_at: Date; update_id: string }>(
    `UPDATE telegram_ingress_updates
        SET stall_alerted_at = now()
      WHERE status = 'processing' AND stall_alerted_at IS NULL
        AND dispatch_started_at < now() - make_interval(secs => $1::double precision)
      RETURNING update_id::text, received_at,
                CASE WHEN payload ? 'guest_message' THEN 'guest'
                     ELSE coalesce(payload->'message'->'chat'->>'type',
                                   payload->'callback_query'->'message'->'chat'->>'type') END AS chat_type`,
    [stallAfterMs / 1000],
  );
  return result.rows.map((row) => ({
    chatType: row.chat_type ?? "unknown",
    receivedAt: row.received_at,
    updateId: row.update_id,
  }));
}

function alertText(stalled: StalledIngress, now: Date): string {
  const minutes = Math.round((now.getTime() - stalled.receivedAt.getTime()) / 60_000);
  const where = stalled.chatType === "private" ? "в личном чате"
    : stalled.chatType === "guest" ? "в гостевом режиме" : "в группе";
  return `${readTelegramAgentIdentity().name} не ответила на сообщение ${where} уже ${minutes} мин (пришло в ` +
    `${stalled.receivedAt.toISOString().slice(11, 16)} UTC): ход, похоже, завис. ` +
    "Если ответа не будет, поможет перезапуск agent.";
}

export async function dispatchIngressStallAlerts(dependencies: {
  claim: () => Promise<StalledIngress[]>;
  deliver: (input: { chatId: string; text: string }) => Promise<void>;
  now?: () => Date;
  recipients: () => Promise<OwnerHealthRecipient[]>;
} = {
  claim: () => claimStalledIngress(),
  deliver: (input) => memoryReviewOwnerAlertTransport.deliver(input),
  recipients: () => ownerHealthDigestRepository.recipients(),
}): Promise<number> {
  const stalled = await dependencies.claim();
  if (stalled.length === 0) return 0;
  // Only the operator hears about it (recipients() is the owner of the earliest family): the alert names a chat type and a
  // time, never a family or a text, and other families have no owner-facing channel for installation health.
  const owners = await dependencies.recipients();
  const now = (dependencies.now ?? (() => new Date()))();
  for (const item of stalled) {
    console.error(JSON.stringify({ code: "AGENT_TELEGRAM_INGRESS_STALLED", receivedAt: item.receivedAt, updateId: item.updateId }));
    for (const owner of owners) {
      await dependencies.deliver({ chatId: owner.ownerTelegramUserId, text: alertText(item, now) });
    }
  }
  return stalled.length;
}
