-- Guest mode (Bot API 10.0, 10 October 2026): anyone in Telegram can mention the bot in any chat, even a
-- private chat between two strangers to the installation, and every answer is paid by the operator.
-- One row per caller and UTC day counts answers, so one person and the whole installation stay under
-- a daily ceiling. Only the Telegram user id and a counter: no text, chat or family.
CREATE TABLE telegram_guest_usage (
  usage_day date NOT NULL,
  telegram_user_id bigint NOT NULL,
  answers integer NOT NULL CHECK (answers > 0),
  PRIMARY KEY (usage_day, telegram_user_id)
);
