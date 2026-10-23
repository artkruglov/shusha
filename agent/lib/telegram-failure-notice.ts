/**
 * The short reply a person gets when a message of theirs was not processed.
 *
 * Exports:
 * - `failureNoticeText`: the person-facing sentence of a failure, without its stable code prefix.
 * - `sendTelegramFailureNotice`: replies to that message in its private chat.
 *
 * Key construct:
 * - Ingress failure texts are written for people («отправьте запись повторно»), but they only
 *   reached the log: a message failed after a restart and the person saw silence. Private chats
 *   only; a group is not told about one member's lost message.
 */
import { sendTelegramMessage, type TelegramUpdate } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../config.js";
import { AppError } from "./app-error.js";

export function failureNoticeText(failure: { code: string; message: string }): string {
  const sentence = failure.message.replace(/^[A-Z][A-Z0-9_]+:\s*/u, "").trim();
  return sentence || "Не удалось обработать это сообщение. Отправьте его ещё раз";
}

export async function sendTelegramFailureNotice(
  update: TelegramUpdate,
  failure: { code: string; message: string },
): Promise<void> {
  if (update.kind !== "message" || update.message.chat.type !== "private") return;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new AppError("AGENT_TELEGRAM_CONFIG_MISSING", "Не задан токен Telegram для уведомления о сбое");
  }
  // Eve owns Telegram request construction; this adapter only bounds the wait.
  const fetchWithTimeout: typeof fetch = (request, init) =>
    fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS) });
  await sendTelegramMessage({
    body: {
      reply_parameters: { allow_sending_without_reply: true, message_id: Number(update.message.messageId) },
      text: failureNoticeText(failure),
    },
    chatId: update.message.chat.id,
    credentials: { botToken },
    fetch: fetchWithTimeout,
  });
}
