/**
 * Какие шаги знакомства есть на этом сервере.
 *
 * Экспорт:
 * - `questAvailability`: флаги те же, что открывают инструменты и советы (`webAppCapabilities`), плюс ссылка
 *   семейного чата: без имени бота чат не подключить, и шаги чата выпадают.
 */
import { familyChatLink } from "../groups-availability.js";
import { webAppCapabilities } from "../web-app/web-app-hints.js";
import type { QuestAvailability } from "./quest-steps.js";

export function questAvailability(): QuestAvailability {
  const capabilities = webAppCapabilities();
  return {
    familyChat: familyChatLink(process.env.TELEGRAM_BOT_USERNAME) !== null,
    grocery: capabilities.grocery,
    images: capabilities.images,
  };
}
