/**
 * Step status transport over the channel's Bot API handle.
 *
 * Constructs covered:
 * - The status is sent silently into the turn's forum topic and its message id is returned.
 * - A refused send returns no id; edit and delete address the same chat.
 */
import { describe, expect, it, vi } from "vitest";

import { telegramStepStatusTransport } from "./telegram-step-status-channel.js";

describe("telegramStepStatusTransport", () => {
  it("sends silently into the topic and edits and deletes the same message", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ body: { ok: true, result: { message_id: 55 } }, ok: true, status: 200 })
      .mockResolvedValue({ body: { ok: true }, ok: true, status: 200 });
    const transport = telegramStepStatusTransport({ chatId: "-1001", messageThreadId: 7, request });

    await expect(transport.send("🔎 Ищу…")).resolves.toBe(55);
    await transport.edit(55, "🔎 Ищу ✓");
    await transport.remove(55);

    expect(request.mock.calls).toEqual([
      ["sendMessage", {
        chat_id: "-1001",
        disable_notification: true,
        link_preview_options: { is_disabled: true },
        message_thread_id: 7,
        text: "🔎 Ищу…",
      }],
      ["editMessageText", { chat_id: "-1001", link_preview_options: { is_disabled: true }, message_id: 55, text: "🔎 Ищу ✓" }],
      ["deleteMessage", { chat_id: "-1001", message_id: 55 }],
    ]);
  });

  it("returns no id when Telegram refuses the send", async () => {
    const request = vi.fn().mockResolvedValue({ body: { ok: false }, ok: false, status: 400 });

    await expect(telegramStepStatusTransport({ chatId: "42", messageThreadId: undefined, request }).send("x")).resolves.toBeNull();
    expect(request.mock.calls[0]![1]).not.toHaveProperty("message_thread_id");
  });
});
