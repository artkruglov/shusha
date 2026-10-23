-- Сообщение, пришедшее в чат во время хода, ждёт в очереди его конца. Тот же человек видит, что
-- агент работает, и часто пишет поправку, короткий вопрос или просит остановиться. Такие сообщения
-- теперь показываются идущему ходу вместе с результатом очередного инструмента, а сама запись в
-- очереди не меняется и после хода проходит обычную обработку.
--
-- Строка здесь проходит три состояния:
-- - сообщение закреплено за одним вызовом инструмента: параллельный вызов того же шага его не
--   покажет, а повтор того же вызова после сбоя покажет снова;
-- - returned_at — результат инструмента с этим сообщением вернулся в ход;
-- - delivered_at — начался следующий шаг модели, и этот результат вошёл в её запрос.
-- Обычный ход, который затем обработает сообщение, получает пометку «ты это уже видел», только если
-- сообщение доставлено и обрабатывается тем же разговором (application_session_id). Иначе оно
-- обрабатывается как новое. Для голосового без расшифровки и для фото или файла агент видел только
-- пометку о том, что сообщение пришло, поэтому content_kind различает показанный текст и пометку.
CREATE TABLE telegram_turn_interjections (
  update_id bigint PRIMARY KEY REFERENCES telegram_ingress_updates(update_id) ON DELETE CASCADE,
  application_session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  eve_session_id text NOT NULL CHECK (char_length(eve_session_id) > 0),
  eve_turn_id text NOT NULL CHECK (char_length(eve_turn_id) > 0),
  tool_call_id text NOT NULL CHECK (char_length(tool_call_id) > 0),
  content_kind text NOT NULL CHECK (content_kind IN ('text', 'voice', 'notice')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  returned_at timestamptz,
  delivered_at timestamptz,
  CHECK (delivered_at IS NULL OR returned_at IS NOT NULL)
);

CREATE INDEX telegram_turn_interjections_undelivered
  ON telegram_turn_interjections (eve_session_id, eve_turn_id)
  WHERE delivered_at IS NULL;

-- Retention deletes old conversations one by one; each cascade must find its rows without a scan.
CREATE INDEX telegram_turn_interjections_session
  ON telegram_turn_interjections (application_session_id);

-- Доставка сообщений, показанных идущему ходу, теперь привязана к номеру шага модели (ревью Codex,
-- 28 сентября 2026). Eve повторяет прерванный шаг с тем же номером и исходной историей: прежняя
-- отметка «следующий шаг начался» считала доставленным результат брошенной попытки, которого в
-- восстановленном запросе нет, и сообщение «стоп» больше не показывалось ходу.
--
-- telegram_turn_steps хранит последний начатый шаг хода (только для ходов, которым показываются
-- такие сообщения). returned_step это шаг, во время которого результат с сообщением вернулся;
-- начало шага N доставляет строки с returned_step < N и освобождает незавершённые строки с
-- returned_step >= N: они от попытки, которую Eve выбросила.
ALTER TABLE telegram_turn_interjections ADD COLUMN returned_step integer CHECK (returned_step >= 0);

CREATE TABLE telegram_turn_steps (
  eve_session_id text NOT NULL CHECK (char_length(eve_session_id) > 0),
  eve_turn_id text NOT NULL CHECK (char_length(eve_turn_id) > 0),
  step_index integer NOT NULL CHECK (step_index >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (eve_session_id, eve_turn_id)
);
CREATE INDEX telegram_turn_steps_started ON telegram_turn_steps (started_at);
