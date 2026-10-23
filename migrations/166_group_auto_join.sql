-- Автоподключение участников семейной группы: включается только командой /family в группе,
-- у групп, подключённых иначе, остаётся выключенным.
ALTER TABLE telegram_groups ADD COLUMN auto_join_members boolean NOT NULL DEFAULT false;
