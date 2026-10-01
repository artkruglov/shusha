-- Повод коуча «как прошло?» (30 сентября 2026).
--
-- Раздел про заботу велит модели записать событие (приём врача, экзамен, трудный разговор) и самой
-- вернуться к нему напоминанием, но это держится на том, что модель в нужный момент сделает оба
-- шага. Коуч возвращается к записанному событию кодом: один вопрос через день-десять после даты,
-- один раз на запись. Читает только личные события самого человека (`kind = 'episode'`, дата
-- события в прошлом), чужого и группового не берёт.
ALTER TABLE initiative_messages DROP CONSTRAINT initiative_messages_coach_reason_check;
ALTER TABLE initiative_messages ADD CONSTRAINT initiative_messages_coach_reason_check
  CHECK (coach_reason IN ('invite', 'decision_open', 'ritual_checkin', 'week_warm',
    'rest_window_missing', 'ritual_none', 'care_area_offer', 'situation_followup'));
