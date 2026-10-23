/**
 * Verified raw Telegram reply attachment extraction.
 *
 * Export:
 * - `telegramReplyAttachmentTarget`: parses one exact-chat/topic reply target without model input.
 */
import { parseTelegramUpdate, type TelegramMessage } from "eve/channels/telegram";

import type { RegisteredGroup } from "./family-access.js";
import { classifyTelegramInboundMedia } from "./telegram-message-policy.js";
import { normalizeRichMessage } from "./telegram-rich-message.js";

export function telegramReplyAttachmentTarget(
  message: TelegramMessage,
  group: RegisteredGroup,
): TelegramMessage | null {
  const rawReply = message.raw.reply_to_message;
  if (!rawReply || typeof rawReply !== "object" || Array.isArray(rawReply)) return null;

  // Reuse Eve's installed parser, then bind every identity field back to the verified current
  // reply reference. Nested webhook data can never select another chat or topic.
  // A channel post replied to carries its picture in rich blocks; it is lifted exactly as on
  // ingress, so the reply sees it and the checks below judge it like an ordinary photo or file.
  const parsed = parseTelegramUpdate({ message: rawReply, update_id: 0 });
  if (parsed?.kind !== "message" || !message.replyToMessage) return null;
  const normalized = normalizeRichMessage(parsed);
  if (normalized.kind !== "message") return null;
  const target = normalized.message;
  if (
    target.chat.id !== message.chat.id ||
    target.chat.id !== group.telegramChatId ||
    target.messageId !== message.replyToMessage.messageId ||
    target.messageThreadId !== message.messageThreadId ||
    target.attachments.length !== 1
  ) return null;

  if (group.type === "family_private") return target;
  const mediaKind = classifyTelegramInboundMedia(target);
  return mediaKind === "native_photo" || mediaKind === "image_document_candidate" ||
    mediaKind === "text_document_candidate"
    ? target
    : null;
}
