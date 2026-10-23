-- Feedback a person sends with /feedback (18 October 2026), before the friends beta.
--
-- A friend family has no other way to tell the operator what gets in the way: the bot answers with the
-- model, and the operator reads no one's chats. The command goes to the operator's private chat without
-- the model; the row keeps the text until it is delivered, counts the person's daily limit and is the
-- record of what was said. It goes with the family, and /delete_me removes the person's rows.
CREATE TABLE feedback_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  telegram_user_id text NOT NULL CHECK (telegram_user_id ~ '^[0-9]{1,20}$'),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX feedback_messages_sender_created ON feedback_messages (telegram_user_id, created_at);

ALTER TABLE feedback_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY osinara_family_scope ON feedback_messages
  USING (osinara_family_row_visible(family_id)) WITH CHECK (osinara_family_row_visible(family_id));
