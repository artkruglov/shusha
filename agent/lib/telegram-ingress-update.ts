/**
 * Pure helpers for one verified Telegram update at the durable ingress boundary.
 *
 * Exports:
 * - `telegramUpdateId`: validated update id of the raw webhook body.
 * - `telegramQueueKey`: one FIFO per chat/topic, or per message-less callback.
 * - `telegramGuestMessage`: the guest message (Bot API 10.0) of a raw update, if it is one.
 * - `telegramGuestQueueKey`: one queue per guest query; guest answers never wait for a chat.
 * - `isTelegramChatJoinRequest`, `telegramJoinQueueKey`: a request to enter a group by an invite link and
 *   its own queue per group, apart from the group's messages: the greeting has five minutes.
 * - `telegramVoiceMetadata`: persisted voice fields of a raw update.
 * - `shouldTranscribeVoice`: every non-channel voice asks for a transcript; the voice authorizer decides.
 * - `withCaptionlessAttachmentText`: non-empty factual model text for a captionless attachment.
 * - `withTranscript`: raw payload with the stored transcript as its message text.
 */
import type { TelegramMessage, TelegramUpdate } from "eve/channels/telegram";
import { telegramContinuationToken } from "eve/channels/telegram";
import { z } from "zod";

import { AppError } from "./app-error.js";

const CAPTIONLESS_ATTACHMENT_MODEL_TEXT = "Пользователь отправил файл без подписи.";

const telegramUpdateIdSchema = z.union([z.number().int().nonnegative().safe(), z.string().regex(/^\d+$/)]);
const telegramVoiceSchema = z.object({
  message: z
    .object({
      voice: z.object({
        file_id: z.string().min(1),
        file_size: z.number().int().positive().optional(),
        mime_type: z.string().min(1).optional(),
      }),
    })
    .passthrough(),
  update_id: telegramUpdateIdSchema,
});

export function telegramUpdateId(raw: Record<string, unknown>): string {
  const parsed = telegramUpdateIdSchema.safeParse(raw.update_id);
  if (!parsed.success) {
    throw new AppError(
      "AGENT_TELEGRAM_UPDATE_ID_INVALID",
      "Telegram передал некорректный идентификатор обновления. Проверьте журнал интеграции",
    );
  }
  return String(parsed.data);
}

export function telegramQueueKey(update: TelegramUpdate): string {
  if (update.kind === "callback_query" && !update.callbackQuery.message) {
    return `telegram:callback:${update.callbackQuery.id}`;
  }
  const message =
    update.kind === "message" ? update.message : update.callbackQuery.message!;

  // One FIFO per chat/topic is stricter than Eve's reply branches and avoids cross-anchor races.
  return telegramContinuationToken({
    chatId: message.chat.id,
    messageThreadId: message.messageThreadId,
  });
}

export function telegramGuestMessage(raw: Record<string, unknown>): Record<string, unknown> | null {
  const message = raw.guest_message;
  return message !== null && typeof message === "object" && !Array.isArray(message)
    ? message as Record<string, unknown>
    : null;
}

export function telegramGuestQueueKey(raw: Record<string, unknown>): string {
  const queryId = telegramGuestMessage(raw)?.guest_query_id;
  if (typeof queryId !== "string" || queryId.length === 0) {
    throw new AppError(
      "AGENT_TELEGRAM_GUEST_QUERY_INVALID",
      "Telegram передал гостевое сообщение без идентификатора запроса",
    );
  }
  return `telegram:guest:${queryId}`;
}

export function isTelegramChatJoinRequest(raw: Record<string, unknown>): boolean {
  const request = raw.chat_join_request;
  return request !== null && typeof request === "object" && !Array.isArray(request);
}

export function telegramJoinQueueKey(raw: Record<string, unknown>): string {
  const chatId = (raw.chat_join_request as { chat?: { id?: unknown } } | undefined)?.chat?.id;
  if (!isTelegramChatJoinRequest(raw) || (typeof chatId !== "number" && typeof chatId !== "string") || !/^-\d+$/u.test(String(chatId))) {
    throw new AppError(
      "AGENT_TELEGRAM_JOIN_REQUEST_INVALID",
      "Telegram передал заявку на вступление без группы",
    );
  }
  return `telegram:join:${chatId}`;
}

export function telegramVoiceMetadata(raw: Record<string, unknown>) {
  const parsed = telegramVoiceSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const voice = parsed.data.message.voice;
  return {
    fileId: voice.file_id,
    ...(voice.file_size === undefined ? {} : { fileSize: voice.file_size }),
    ...(voice.mime_type === undefined ? {} : { mimeType: voice.mime_type }),
  };
}

/**
 * Голос расшифровывается до решения об адресации: имя, сказанное голосом, иначе не распознать, а
 * семейная группа в режиме `all` слышит и реплики без обращения. Кого расшифровывать, решает
 * авторизация голоса: только личный чат семьи и семейная группа, внешние до провайдера не доходят.
 */
export function shouldTranscribeVoice(message: Pick<TelegramMessage, "chat">): boolean {
  return message.chat.type !== "channel";
}

export function withCaptionlessAttachmentText(update: TelegramUpdate): TelegramUpdate {
  if (
    update.kind !== "message" ||
    update.message.attachments.length === 0 ||
    update.message.text.trim() ||
    update.message.caption.trim()
  ) {
    return update;
  }

  // Eve no longer forwards persisted bytes to the text-only primary model. Keep its final user
  // message non-empty while describing only the verified event, not inventing a file request.
  return {
    ...update,
    message: {
      ...update.message,
      text: CAPTIONLESS_ATTACHMENT_MODEL_TEXT,
    },
  };
}

export function withTranscript(payload: Record<string, unknown>, transcript: string): Record<string, unknown> {
  const cloned = structuredClone(payload);
  const message = cloned.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new AppError(
      "AGENT_TELEGRAM_VOICE_INVALID",
      "Telegram передал неполные данные голосового сообщения. Запишите и отправьте его заново",
    );
  }
  (message as Record<string, unknown>).text = transcript;
  return cloned;
}
