-- Лист ожидания саморегистрации: кому при полном наборе ответили «мест нет». Когда оператор расширяет набор,
-- первым по очереди уходит одно сообщение «места появились» (notified_at ставится один раз).
CREATE TABLE signup_waitlist (
  telegram_user_id text PRIMARY KEY,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);
