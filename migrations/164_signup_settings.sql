-- Саморегистрация семей: оператор открывает и закрывает вход командой /signup в личке, консоль сервера не нужна.
--
-- Одна строка настроек на установку: открыт ли вход, необязательное слово в ссылке (`t.me/бот?start=слово`) и потолок числа семей.
-- По умолчанию вход закрыт. Слово не секрет уровня пароля: оно прячет бота от случайных людей, а потолок и закрытие защищают расходы.
CREATE TABLE signup_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  is_open boolean NOT NULL DEFAULT false,
  word text CHECK (word IS NULL OR word ~ '^[A-Za-z0-9_-]{1,64}$'),
  max_families integer NOT NULL DEFAULT 0 CHECK (max_families >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO signup_settings (singleton) VALUES (true);
