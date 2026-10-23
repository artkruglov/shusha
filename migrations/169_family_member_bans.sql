-- Убранный владельцем участник не возвращается сам: ни автовходом в группе, ни старой ссылкой, ни ожидавшей подтверждения заявкой.
-- Запрет снимает только явное решение владельца («верни Юлю»). Ключ ссылки на запрет это `id`, как participantRef у участника.
CREATE TABLE family_member_bans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  telegram_user_id text NOT NULL,
  display_name text NOT NULL,
  banned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  banned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, telegram_user_id)
);
