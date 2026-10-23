/**
 * Replies to a rich channel post see its picture under the usual group media rules.
 *
 * Constructs covered:
 * - The reply target's one photo block is lifted as on ingress (largest size, Eve's attachment).
 * - A family group captures it; an external group only with the live `inspect_workspace_image` grant.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it } from "vitest";

import type { RegisteredGroup } from "./family-access.js";
import {
  BOT_USERNAME,
  groupMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";
import { telegramReplyAttachmentTarget } from "./telegram-reply-attachment.js";

const photo = [
  { file_id: "post-small", file_size: 1_000, file_unique_id: "u-post", height: 90, width: 90 },
  { file_id: "post-large", file_size: 80_000, file_unique_id: "u-post", height: 1_280, width: 1_280 },
];

function replyToChannelPost(): TelegramMessage {
  return {
    ...groupMessage(`@${BOT_USERNAME} что на картинке?`),
    messageId: "42",
    raw: {
      date: 1_700_000_001,
      reply_to_message: {
        chat: { id: "group-101", type: "group" },
        date: 1_700_000_000,
        from: { first_name: "Telegram", id: 777_000, is_bot: false },
        message_id: 41,
        rich_message: { blocks: [{ photo, type: "photo" }, { text: "пост про эвалы", type: "paragraph" }] },
        sender_chat: { id: -1_001_000_000_002, title: "Канал", type: "channel" },
      },
    },
    replyToMessage: {
      chat: { id: "group-101", type: "group" },
      from: { id: "777000", isBot: false },
      messageId: "41",
    },
  };
}

function group(type: RegisteredGroup["type"], toolAllowlist: string[]): RegisteredGroup {
  return { familyId: "family-1", groupId: "group-1", messageMode: "addressed_only", telegramChatId: "group-101", toolAllowlist, type };
}

async function handleReply(registered: RegisteredGroup) {
  const repository = repositories();
  repository.telegram.findGroup.mockResolvedValue(registered);
  repository.telegram.findIdentity.mockResolvedValue({ familyId: "family-1", role: "member", userId: "user-1" });
  repository.attachmentReferences.captureReplyTarget.mockResolvedValue({
    attachmentId: "00000000-0000-4000-8000-000000000041",
    kind: "photo",
    mediaType: "image/jpeg",
    telegramMessageId: "41",
  });
  await createTelegramMessageHandler(repository)(telegramContext().context, replyToChannelPost());
  return repository.attachmentReferences.captureReplyTarget;
}

describe("replies to a rich channel post", () => {
  it("lifts the post's photo into the reply target the way Eve parses a photo message", () => {
    expect(telegramReplyAttachmentTarget(replyToChannelPost(), group("external", []))).toMatchObject({
      attachments: [{ fileId: "post-large", fileName: "photo.jpg", kind: "photo", mediaType: "image/jpeg" }],
      messageId: "41",
      text: "пост про эвалы",
    });
  });

  it("captures the picture in a family group", async () => {
    const capture = await handleReply(group("family_private", []));
    expect(capture).toHaveBeenCalledWith("group-1", expect.any(String), expect.objectContaining({
      attachments: [expect.objectContaining({ fileId: "post-large" })],
      messageId: "41",
    }));
  });

  it("captures the picture in an external group with the live image grant", async () => {
    const capture = await handleReply(group("external", ["inspect_workspace_image"]));
    expect(capture).toHaveBeenCalledWith("group-1", expect.any(String), expect.objectContaining({
      attachments: [expect.objectContaining({ fileId: "post-large" })],
    }));
  });

  it("does not expose the picture in an external group without the grant", async () => {
    const capture = await handleReply(group("external", ["import_telegram_attachment"]));
    expect(capture).not.toHaveBeenCalled();
  });
});
