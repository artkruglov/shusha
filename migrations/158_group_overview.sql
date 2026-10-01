-- Утренний разбор семейных дел в семейной группе (29 сентября 2026).
--
-- Прод показал, что жена ведёт дела с ботом в семейной группе (16 сообщений за две недели, четыре
-- созданных дела), а в личку почти не заходит: три личных сообщения бота (два обзора и
-- уведомление о предложенном ей деле) остались непрочитанными. Всё общее, что бот начинает сам,
-- шло только в личку. Теперь раз в утро в семейную группу уходит один разбор общих дел, когда они
-- есть и в группе кто-то пишет; личное в него не попадает.
--
-- Отправка идёт под заявкой на сутки группы: уникальный ключ не даёт двум тикам отправить два
-- одинаковых разбора. Выключатель на группе: владелец гасит разбор одной фразой в личном чате.
ALTER TYPE proactive_delivery_source_kind ADD VALUE 'group_overview';

ALTER TABLE telegram_groups ADD COLUMN daily_overview_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE group_overview_claims (
  group_id uuid NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  sent_on date NOT NULL,
  delivery_ref uuid NOT NULL DEFAULT gen_random_uuid(),
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, sent_on)
);
