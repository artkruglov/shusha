-- Guest chat memory (12 October 2026). A guest answer (migration 173) knew nothing of the chat it was
-- summoned into: «@бот запомни: падл с Максимом» was refused and sent to the private chat. The guest
-- message carries the chat, so notes and tasks can live with it. In a one-to-one chat `chat.id` is the
-- caller's peer, not the conversation (seen in prod updates: A summoning in A↔B gets B's id, B gets
-- A's), so a private chat is keyed by the unordered pair of the two ids (`p:<low>:<high>`) and any
-- other chat by its id (`c:<id>`). The key is its own namespace (Bot API: ids may coincide with an
-- unrelated bot chat), never joined to families or groups: whoever summons the bot in that chat sees
-- its notes, and nothing personal or familial is stored here.
-- A chat not summoned for 90 days is deleted with everything in it.
CREATE TABLE telegram_guest_chats (
  chat_key text PRIMARY KEY CHECK (chat_key ~ '^(p:[0-9]{1,20}:[0-9]{1,20}|c:-?[0-9]{1,20})$'),
  last_summoned_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX telegram_guest_chats_last_summoned ON telegram_guest_chats (last_summoned_at);

-- A note is what people asked the bot to keep; a task is a note with a due date or a done mark.
CREATE TABLE telegram_guest_chat_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_key text NOT NULL REFERENCES telegram_guest_chats(chat_key) ON DELETE CASCADE,
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 500),
  due_on date,
  done_at timestamptz,
  author_telegram_user_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX telegram_guest_chat_notes_chat ON telegram_guest_chat_notes (chat_key, created_at);

-- «Напомни нам»: the bot cannot write into the chat first, so the answer offers a button and every
-- family member who presses it gets a personal reminder in their private chat (reminders table).
CREATE TABLE telegram_guest_reminder_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_key text NOT NULL REFERENCES telegram_guest_chats(chat_key) ON DELETE CASCADE,
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 500),
  run_at timestamptz NOT NULL,
  author_telegram_user_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX telegram_guest_reminder_offers_run_at ON telegram_guest_reminder_offers (run_at);
