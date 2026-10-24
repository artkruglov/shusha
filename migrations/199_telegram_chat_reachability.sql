-- Chats that can no longer receive the bot's messages (24 October 2026). A blocked bot, a deleted
-- account, a bot removed from a group or a chat Telegram does not know answer every send with the same
-- 403/400, yet morning overviews, reminders, digests and scheduled runs kept writing into such a chat
-- every time. A proactive send now skips a marked chat; an answer to a person's own message never reads
-- this table (`agent/lib/telegram-reachability/`).
--
-- A row is set by a classified delivery failure (`delivery`) or by Telegram's `my_chat_member` update
-- (`membership_update`), and cleared by any message from that chat (`inbound_message`) or by a later
-- `my_chat_member` that shows the bot back. Updates may arrive out of order over parallel webhook
-- connections, so the newest update of either kind applied to the chat is kept as (`last_event_at`, the
-- Telegram date of the message or membership change, and `last_update_id`), and an update not newer by
-- that pair is ignored: a later date wins, an equal date is decided by update id. Update ids alone are not
-- an order: after a week without updates Telegram picks the next one at random (Bot API, `Update`).
-- `reachable_evidence_at` is when the
-- application last received proof that the chat reaches the bot (a message, an unblock, a return to the
-- group): a 403 to a send that started before that moment is stale and marks nothing, even when the chat
-- had no row yet. Ids, reasons and times only; no content.
CREATE TABLE telegram_chat_reachability (
  telegram_chat_id text PRIMARY KEY CHECK (char_length(telegram_chat_id) BETWEEN 1 AND 64),
  unreachable_reason text CHECK (unreachable_reason IN (
    'blocked', 'deactivated', 'kicked', 'not_found', 'not_member', 'not_started'
  )),
  unreachable_since timestamptz,
  source text NOT NULL CHECK (source IN ('delivery', 'membership_update', 'inbound_message')),
  last_event_at timestamptz,
  last_update_id bigint CHECK (last_update_id >= 0),
  reachable_evidence_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_chat_reachability_reason_since CHECK (
    (unreachable_reason IS NULL) = (unreachable_since IS NULL)
  ),
  CONSTRAINT telegram_chat_reachability_last_event CHECK (
    (last_event_at IS NULL) = (last_update_id IS NULL)
  )
);
