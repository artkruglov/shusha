-- Повод коуча «направление, которое ты ведёшь целиком» (29 сентября 2026).
--
-- Fair Play в продукте был пассивным инструментом: на проде областей заботы ноль, потому что
-- разговор о них никто не начинал, кроме самого человека, который знал волшебные слова. Коуч теперь
-- раз в две недели спрашивает того, у кого нет ни одной области, что он ведёт целиком. Код дел не
-- читает и нагрузку не считает: спрашивает только по факту, что у человека нет принятой области.
ALTER TABLE initiative_messages DROP CONSTRAINT initiative_messages_coach_reason_check;
ALTER TABLE initiative_messages ADD CONSTRAINT initiative_messages_coach_reason_check
  CHECK (coach_reason IN ('invite', 'decision_open', 'ritual_checkin', 'week_warm',
    'rest_window_missing', 'ritual_none', 'care_area_offer'));
