-- Заявки в обычную группу семьи («Группы», шаг 2, 20 октября 2026): кого бот встретил в личке и ждёт ли тот
-- решения владельца.
--
-- Telegram держит саму заявку, но не знает, что бот её уже обработал. Строка доказывает, что приветствие ушло
-- именно этому человеку про эту группу (кнопку с чужим id чата не нажать), и делает каждое решение однократным:
-- нажатие сначала забирает строку, и только потом идёт в Telegram, поэтому повтор после сбоя не шлёт владельцу
-- второй вопрос. Строка удаляется решением; забытые удаляются через 30 дней при следующей заявке.
CREATE TABLE group_join_invitations (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  telegram_user_id text NOT NULL CHECK (telegram_user_id ~ '^[0-9]{1,20}$'),
  status text NOT NULL CHECK (status IN ('greeted', 'asked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, telegram_user_id)
);

CREATE INDEX group_join_invitations_created ON group_join_invitations (created_at);

ALTER TABLE group_join_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_join_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY osinara_family_scope ON group_join_invitations
  USING (osinara_family_row_visible(family_id)) WITH CHECK (osinara_family_row_visible(family_id));
