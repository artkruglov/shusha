/**
 * The short reply a person gets when a message of theirs was not processed.
 *
 * Exports:
 * - `TelegramFailureNotice`: a failed update's code, message and whether its dispatch had started.
 * - `UNCERTAIN_DELIVERY_NOTICE`: the conditional sentence for a message that may have been processed.
 * - `failureNoticeText`: the person-facing sentence of a failure, never a code or a runtime name.
 * - `sendTelegramFailureNotice`: replies to that message in its private chat.
 *
 * Key construct:
 * - Ingress failure texts are written for people («отправьте запись повторно»), but until
 *   2 October 2026 they only reached the log: two messages failed after a restart and the person saw
 *   silence. Private chats only; a group is not told about one member's lost message.
 * - Once the dispatch marker is set the message may already be in a turn: an unconditional «отправьте
 *   ещё раз» would make the person send a duplicate, so the advice is conditional.
 */
import { sendTelegramMessage, type TelegramUpdate } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../config.js";
import { AppError } from "./app-error.js";
import { withRequestTimeout } from "./request-signal.js";

export interface TelegramFailureNotice {
  code: string;
  /** True once `beginDispatch` set the marker in this or an earlier attempt. */
  dispatchStarted: boolean;
  message: string;
}

export const UNCERTAIN_DELIVERY_NOTICE =
  "Не уверена, что обработала это сообщение: если ответа на него не было, отправьте его ещё раз.";

const NOT_PROCESSED_NOTICE = "Не удалось обработать это сообщение. Отправьте его ещё раз.";

// Internal wording that must never reach a person: stable codes and the runtime's name.
const INTERNAL_WORDING = /AGENT_|\bEve\b/u;

export function failureNoticeText(failure: TelegramFailureNotice): string {
  if (failure.dispatchStarted || failure.code === "AGENT_TELEGRAM_DISPATCH_RECOVERY_REQUIRED") {
    return UNCERTAIN_DELIVERY_NOTICE;
  }
  const sentence = failure.message.replace(/^[A-Z][A-Z0-9_]+:\s*/u, "").trim();
  return sentence && !INTERNAL_WORDING.test(sentence) ? sentence : NOT_PROCESSED_NOTICE;
}

export async function sendTelegramFailureNotice(
  update: TelegramUpdate,
  failure: TelegramFailureNotice,
): Promise<void> {
  if (update.kind !== "message" || update.message.chat.type !== "private") return;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new AppError("AGENT_TELEGRAM_CONFIG_MISSING", "Не задан токен Telegram для уведомления о сбое");
  }
  await sendTelegramMessage({
    body: {
      reply_parameters: { allow_sending_without_reply: true, message_id: Number(update.message.messageId) },
      text: failureNoticeText(failure),
    },
    chatId: update.message.chat.id,
    credentials: { botToken },
    fetch: withRequestTimeout((request, init) => fetch(request, init), TELEGRAM_API_REQUEST_TIMEOUT_MS),
  });
}
