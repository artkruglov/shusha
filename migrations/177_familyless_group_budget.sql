-- Monthly model budget of a group without a family (15 October 2026). Every such group gets a dollar
-- budget when it is turned on (migration 176); before a turn the month's spend in that chat is compared
-- with it, and once it is used up the chat hears one notice a month and then silence.
--
-- Spend and the notice are keyed by the Telegram chat, not by the group row: /stop and /start create a
-- new row, and anything keyed by the row would reset with it. A row of a group's call keeps only the
-- chat id and the numbers, for 40 days (agent/lib/health/model-usage-repository.ts), so a whole UTC
-- month is always covered; family calls stay unattributed as before.
ALTER TABLE model_usage_events
  ADD COLUMN familyless_chat_id text CHECK (familyless_chat_id ~ '^-?[0-9]{1,20}$');

CREATE INDEX model_usage_events_familyless_chat ON model_usage_events (familyless_chat_id, created_at)
  WHERE familyless_chat_id IS NOT NULL;

-- The chat already heard that this UTC month's budget is used up. Kept two months, then purged.
CREATE TABLE familyless_group_budget_notices (
  telegram_chat_id text NOT NULL CHECK (telegram_chat_id ~ '^-?[0-9]{1,20}$'),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  notified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_chat_id, month)
);
