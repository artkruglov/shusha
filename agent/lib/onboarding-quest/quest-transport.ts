/**
 * Отправка сообщений знакомства: карточка шага фотографией по адресу рядом с Mini App, подсказка с кнопкой-фразой.
 *
 * Экспорт:
 * - `QuestReplyMarkup`: инлайн-кнопки под карточкой или клавиатура с фразой внизу.
 * - `QuestTransport`, `createQuestTransport`, `questTransport`: `card` и `text`, оба возвращают id сообщения.
 *
 * Без публичного адреса Mini App карточек нет, и шаг уходит той же подписью без картинки. Отказ Telegram это
 * `MemoryReviewOwnerAlertTransportError` (определённый отказ), как у остальной инициативы: заявку не возвращают.
 */
import { callTelegramApi, type TelegramApiResponse } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import { webAppUrl } from "../web-app/web-app-menu.js";
import { questCardFile, type QuestStep } from "./quest-steps.js";

type InlineButton = { callback_data: string; text: string } | { text: string; url: string };

export type QuestReplyMarkup =
  | { inline_keyboard: InlineButton[][] }
  | { keyboard: Array<Array<{ text: string }>>; one_time_keyboard: true; resize_keyboard: true };

export interface QuestTransport {
  card(input: { caption: string; chatId: string; replyMarkup: QuestReplyMarkup; step: QuestStep }): Promise<string>;
  text(input: { chatId: string; replyMarkup?: QuestReplyMarkup; text: string }): Promise<string>;
}

type Call = (method: string, body: Record<string, unknown>) => Promise<TelegramApiResponse>;

function messageId(response: TelegramApiResponse): string {
  if (!response.ok) {
    throw new MemoryReviewOwnerAlertTransportError("failed", "AGENT_ONBOARDING_QUEST_TELEGRAM_REJECTED",
      "Telegram не принял сообщение знакомства");
  }
  const id = (response.body as { result?: { message_id?: unknown } } | null)?.result?.message_id;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) {
    throw new AppError("AGENT_TELEGRAM_MESSAGE_ID_MISSING", "Telegram принял сообщение, но не подтвердил его идентификатор");
  }
  return String(id);
}

export function createQuestTransport(call: Call, app: () => string | null = webAppUrl): QuestTransport {
  const text: QuestTransport["text"] = async (input) => messageId(await call("sendMessage", {
    chat_id: input.chatId, text: input.text, ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
  }));
  return {
    async card(input) {
      const base = app();
      if (base === null) return text({ chatId: input.chatId, replyMarkup: input.replyMarkup, text: input.caption });
      return messageId(await call("sendPhoto", {
        caption: input.caption, chat_id: input.chatId,
        photo: new URL(questCardFile(input.step), base).toString(), reply_markup: input.replyMarkup,
      }));
    },
    text,
  };
}

function botToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new AppError("AGENT_TELEGRAM_CONFIG_MISSING", "Не задан токен Telegram для сообщений знакомства");
  return token;
}

const timedFetch: typeof fetch = (request, init) =>
  fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS) });

// The token is read lazily so Eve discovery and build stay deterministic.
export const questTransport: QuestTransport = createQuestTransport((method, body) => callTelegramApi({
  body: body as never, botToken: botToken(), fetch: timedFetch, method,
}));
