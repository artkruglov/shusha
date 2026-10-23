/**
 * Все @имена этого бота. Основное (`TELEGRAM_BOT_USERNAME`) идёт в ссылки; дополнительные
 * (`TELEGRAM_BOT_USERNAME_ALIASES`, через запятую) только узнаются: в упоминании, в ответе на сообщение бота,
 * в `/команда@имя` и в гостевом вызове.
 *
 * Exports:
 * - `telegramBotUsernames`: основное имя и дополнительные, без повторов, в нижнем регистре.
 * - `isOwnBotUsername`: принадлежит ли имя этому боту.
 *
 * У Юны два активных имени, `yuna_agentbot` и `yuna_agent` (23 октября 2026); Telegram подписывает сообщения бота
 * одним из них, а люди упоминают любое. Сравнение с одним именем молча теряло обращения по второму.
 */
import { AppError } from "./app-error.js";

const USERNAME_PATTERN = /^[A-Za-z0-9_]{4,32}$/u;

type Environment = Readonly<Record<string, string | undefined>>;

export function telegramBotUsernames(primary: string, environment: Environment = process.env): readonly string[] {
  const aliases = (environment.TELEGRAM_BOT_USERNAME_ALIASES ?? "").split(",").map((name) => name.trim().replace(/^@/u, ""))
    .filter((name) => name !== "");
  for (const name of aliases) {
    if (!USERNAME_PATTERN.test(name)) {
      throw new AppError("AGENT_TELEGRAM_CONFIG_INVALID", "TELEGRAM_BOT_USERNAME_ALIASES: имя бота из латиницы, цифр и _");
    }
  }
  return [...new Set([primary, ...aliases].map((name) => name.toLowerCase()))];
}

export function isOwnBotUsername(candidate: string | undefined | null, primary: string): boolean {
  return typeof candidate === "string" && telegramBotUsernames(primary).includes(candidate.toLowerCase());
}
