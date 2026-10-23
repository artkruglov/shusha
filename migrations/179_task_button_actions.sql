-- Buttons under the bot's messages that act on a task without the model (17 October 2026).
--
-- The model wrote «считаю сделанным» without closing anything, and the morning overview was a sheet
-- where the important part was cut. A button closes the task in code with one tap
-- (docs/telegram-task-buttons-plan.ru.md). Telegram limits callback_data to 64 bytes and shows it to
-- anyone who sees the message, so the button carries only `tb:<id>` of a row here; the meaning lives
-- in the database: which task, at which version, what to do, in which chat and for whom.
--
-- The press is authorized again from Telegram and PostgreSQL: the row only says what the button
-- was made for. chat_id must equal the chat the press came from (a forwarded button is refused);
-- recipient_telegram_id, when set, must equal the presser; otherwise the presser must be a live member
-- of the family of a family group. The repository then checks rights and version as in a chat turn.
-- A row lives seven days; the minute schedule removes expired ones.
CREATE TABLE task_button_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  task_id uuid REFERENCES shared_tasks(id) ON DELETE CASCADE,
  task_version integer CHECK (task_version > 0),
  action text NOT NULL CHECK (action IN (
    'complete', 'reopen', 'claim', 'accept', 'decline', 'all_tasks', 'digest_settings', 'digest_hour', 'digest_off'
  )),
  -- The hour a «7:00 … 10:00» button of the morning overview settings sets (migration 180).
  setting_value smallint CHECK (setting_value BETWEEN 5 AND 12),
  chat_id text NOT NULL CHECK (chat_id ~ '^-?[0-9]{1,20}$'),
  recipient_telegram_id text CHECK (recipient_telegram_id ~ '^[0-9]{1,20}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- After a press the button becomes another one («✓» into «↩ Вернуть») or disappears. The keyboard is
  -- redrawn from these columns, not from the copy in the update: two quick presses each carry the
  -- keyboard as it was before either, and the second redraw would bring the first button back.
  replaced_by uuid REFERENCES task_button_actions(id) ON DELETE SET NULL,
  removed_at timestamptz,
  -- «Все дела» sends a message: the press that claimed it is recorded before sending, so a replay of the
  -- same update after an ambiguous crash does not send the board twice.
  dispatched_query_id text,
  CHECK (replaced_by IS NULL OR removed_at IS NULL),
  CHECK ((action IN ('all_tasks', 'digest_settings', 'digest_hour', 'digest_off')) = (task_id IS NULL)),
  CHECK ((action = 'digest_hour') = (setting_value IS NOT NULL)),
  CHECK ((task_id IS NULL) = (task_version IS NULL)),
  CHECK (expires_at > created_at)
);

CREATE INDEX task_button_actions_expires_at ON task_button_actions (expires_at);
CREATE INDEX task_button_actions_task ON task_button_actions (task_id) WHERE task_id IS NOT NULL;

ALTER TABLE task_button_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_button_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY osinara_family_scope ON task_button_actions
  USING (osinara_family_row_visible(family_id)) WITH CHECK (osinara_family_row_visible(family_id));
