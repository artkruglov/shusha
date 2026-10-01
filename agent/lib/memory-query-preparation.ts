/**
 * Превращает живое сообщение в текст, по которому реально идёт поиск памяти.
 *
 * Экспорт:
 * - `prepareMemoryQuery`: снимает обращение к ассистенту, эмодзи и парную разметку Markdown.
 *
 * Зачем: раньше в поиск уходило сообщение как набрано. Словесные ветки строят условие из каждого
 * слова, поэтому «Шуша, напомни где бэкап» требовало, чтобы запись содержала имя самого
 * ассистента; таких записей почти нет, а те, что есть, не про то. Тот же шум смещает смысловой
 * вектор. Очищенный текст поэтому идёт и в словесные ветки, и в эмбеддинг.
 *
 * Чего функция не делает: не сводит «ё» к «е». Морфологическая ветка сводит её сама, модель
 * эмбеддинга не различает, а точной ветке нужно одинаковое сведение у запроса и у колонки, и оно
 * задано в самой колонке (миграция 156).
 *
 * Перенос из upstream 3a1acdb (7 сентября 2026): у них имя жёстко «Осинара» в общем списке
 * написаний, у нас оно настраивается (`TELEGRAM_AGENT_NAME`), поэтому обращением считается только
 * настроенное имя в именительном падеже. Косвенные формы («Шуши», «Шуше») обращением не бывают:
 * это вопрос ПРО ассистента, и потерять имя там значит подменить один проект другим.
 */
import { readTelegramAgentIdentity, type TelegramAgentIdentity } from "./telegram-agent-identity.js";

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

interface AddressPatterns {
  readonly enclosed: RegExp;
  readonly leading: RegExp;
  readonly leadingBeforeGreeting: RegExp;
  readonly leadingMention: RegExp;
}

function addressPatterns(identity: TelegramAgentIdentity): AddressPatterns {
  const nominative = escapeForPattern(identity.name);
  // Ник бота в Telegram латиницей и обычно с суффиксом («@shusha_bot»), поэтому упоминание ловится
  // по основам (имя и латинские алиасы без последней буквы), а не по самому имени.
  const stems = [identity.name, ...identity.aliases.filter((alias) => /^[A-Za-z]+$/u.test(alias))]
    .map((value) => escapeForPattern(value.slice(0, Math.max(value.length - 1, 1))));
  const mention = `@(?:${[...new Set(stems)].join("|")})[\\p{L}\\p{N}_]*`;
  const addressName = `(?:${mention}|${nominative})`;
  return {
    // Имя между запятыми это звательная форма, где бы оно ни стояло.
    enclosed: new RegExp(`,\\s*${addressName}\\s*,`, "giu"),
    // Обращение в начале идёт с запятой сразу («Шуша, напомни»). Без запятой имя может быть
    // подлежащим («Шуша умеет читать PDF?»), и безопаснее оставить: слово не теряет смысла.
    leading: new RegExp(`^\\s*${addressName}\\s*[,!:]\\s*`, "iu"),
    // «Шуша привет, какой тариф»: приветствие стоит между именем и запятой.
    leadingBeforeGreeting: new RegExp(`^\\s*${addressName}(?=\\s)\\s*(?=[^,]{0,24},)`, "iu"),
    // Упоминание Telegram в начале сообщения обращение и без запятой.
    leadingMention: new RegExp(`^\\s*${mention}\\s*[,!:]?\\s*`, "iu"),
  };
}

// Пиктограммы, их модификаторы тона и стиля, нулевой соединитель и селектор варианта.
const EMOJI_PATTERN =
  /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{1F3FB}-\u{1F3FF}\u{200D}\u{FE0F}\u{20E3}]/gu;

// Только парное выделение и блоки кода, никогда одиночные `*` и `_`: `memory_items` и `*` в пути
// встречаются куда чаще курсива, и вырезать их значит сломать точную ветку.
const MARKDOWN_EMPHASIS_PATTERN = /\*\*|__|~~|`/gu;
const MARKDOWN_LINE_PREFIX_PATTERN = /^[ \t]*(?:#{1,6}|>)[ \t]+/gmu;

export function prepareMemoryQuery(
  query: string,
  identity: TelegramAgentIdentity = readTelegramAgentIdentity(),
): string {
  const patterns = addressPatterns(identity);
  const prepared = query
    .replace(patterns.enclosed, ", ")
    .replace(patterns.leadingMention, "")
    .replace(patterns.leading, "")
    .replace(patterns.leadingBeforeGreeting, "")
    .replace(EMOJI_PATTERN, " ")
    .replace(MARKDOWN_LINE_PREFIX_PATTERN, "")
    .replace(MARKDOWN_EMPHASIS_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim();

  // Сообщение из одного обращения не оставляет слов для поиска: голая пунктуация так же пуста,
  // как пустая строка. Возврат исходного сохраняет прежнее поведение хода, а не роняет блок памяти.
  return /[\p{L}\p{N}]/u.test(prepared) ? prepared : query;
}
