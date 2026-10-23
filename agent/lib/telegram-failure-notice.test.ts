/**
 * Failure notice tests.
 *
 * Constructs covered:
 * - The person reads the failure sentence without its stable code prefix, or a plain fallback.
 * - A group message never produces a notice.
 */
import { describe, expect, it, vi } from "vitest";

import { failureNoticeText, sendTelegramFailureNotice } from "./telegram-failure-notice.js";

describe("telegram failure notice", () => {
  it("shows the person-facing sentence only", () => {
    expect(failureNoticeText({
      code: "AGENT_TELEGRAM_INGRESS_FAILED",
      message: "AGENT_TELEGRAM_INGRESS_FAILED: Не удалось обработать сообщение Telegram",
    })).toBe("Не удалось обработать сообщение Telegram");
    expect(failureNoticeText({ code: "AGENT_VOICE_FILE_TOO_LARGE", message: "Отправьте более короткую запись" }))
      .toBe("Отправьте более короткую запись");
    expect(failureNoticeText({ code: "X", message: "AGENT_X: " })).toBe("Не удалось обработать это сообщение. Отправьте его ещё раз");
  });

  it("stays silent outside a private chat", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await sendTelegramFailureNotice({
      kind: "message",
      message: { attachments: [], caption: "", chat: { id: "-100", type: "group" }, messageId: "7", raw: {}, text: "привет" },
    } as never, { code: "AGENT_TELEGRAM_INGRESS_FAILED", message: "Не удалось" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
