/**
 * Failure notice tests.
 *
 * Constructs covered:
 * - The person reads the failure sentence without its stable code prefix, or a plain fallback.
 * - Once dispatch had started the advice is conditional, never a bare «отправьте ещё раз».
 * - No notice carries a stable code or the runtime's name, including the session boundary texts.
 * - A group message never produces a notice.
 */
import { describe, expect, it, vi } from "vitest";

import { failureNoticeText, sendTelegramFailureNotice, UNCERTAIN_DELIVERY_NOTICE } from "./telegram-failure-notice.js";
import { waitForSessionBoundary } from "./telegram-session-boundary.js";

const INTERNAL = /AGENT_|\bEve\b/u;

describe("telegram failure notice", () => {
  it("shows the person-facing sentence only", () => {
    expect(failureNoticeText({
      code: "AGENT_TELEGRAM_INGRESS_FAILED",
      dispatchStarted: false,
      message: "AGENT_TELEGRAM_INGRESS_FAILED: Не удалось обработать сообщение Telegram",
    })).toBe("Не удалось обработать сообщение Telegram");
    expect(failureNoticeText({ code: "AGENT_VOICE_FILE_TOO_LARGE", dispatchStarted: false, message: "Отправьте более короткую запись" }))
      .toBe("Отправьте более короткую запись");
    expect(failureNoticeText({ code: "X", dispatchStarted: false, message: "AGENT_X: " }))
      .toBe("Не удалось обработать это сообщение. Отправьте его ещё раз.");
  });

  it("replaces internal wording with a plain sentence", () => {
    for (const message of ["Срок передачи сообщения в Eve истёк", "Сбой AGENT_TELEGRAM_LEASE_LOST при передаче"]) {
      const text = failureNoticeText({ code: "AGENT_TELEGRAM_INGRESS_FAILED", dispatchStarted: false, message });
      expect(text).not.toMatch(INTERNAL);
      expect(text).toBe("Не удалось обработать это сообщение. Отправьте его ещё раз.");
    }
  });

  it("gives conditional advice for every failure after dispatch started", () => {
    for (const failure of [
      { code: "AGENT_TELEGRAM_SESSION_HOOK_AMBIGUOUS", message: "Сессия не подтвердила приём сообщения" },
      { code: "AGENT_TELEGRAM_SESSION_BOUNDARY_TIMEOUT", message: "Ответ не пришёл. Отправьте сообщение ещё раз" },
      { code: "AGENT_TELEGRAM_INGRESS_FAILED", message: "Не удалось обработать сообщение Telegram" },
    ]) {
      expect(failureNoticeText({ ...failure, dispatchStarted: true })).toBe(UNCERTAIN_DELIVERY_NOTICE);
    }
    // An interrupted dispatch of an earlier attempt is refused by its marker before this attempt sets it.
    expect(failureNoticeText({ code: "AGENT_TELEGRAM_DISPATCH_RECOVERY_REQUIRED", dispatchStarted: false, message: "x" }))
      .toBe(UNCERTAIN_DELIVERY_NOTICE);
    expect(UNCERTAIN_DELIVERY_NOTICE).toBe("Не уверена, что обработала это сообщение: если ответа на него не было, отправьте его ещё раз.");
  });

  it("keeps the session boundary texts free of codes and the runtime's name", async () => {
    const missing = await waitForSessionBoundary(
      { getEventStream: async () => new ReadableStream({ start(c) { c.close(); } }), id: "closed" },
      0,
      { idleMilliseconds: 1_000, updateId: "1" },
    ).catch((error: unknown) => error as Error);
    const timeout = await waitForSessionBoundary(
      { getEventStream: () => new Promise(() => {}), id: "silent" },
      0,
      { idleMilliseconds: 5, updateId: "2" },
    ).catch((error: unknown) => error as Error);
    for (const error of [missing, timeout]) {
      expect(error).toBeInstanceOf(Error);
      const sentence = (error as Error).message.replace(/^[A-Z][A-Z0-9_]+:\s*/u, "");
      expect(sentence).not.toMatch(INTERNAL);
      expect(failureNoticeText({ code: "X", dispatchStarted: false, message: (error as Error).message })).toBe(sentence);
    }
  });

  it("stays silent outside a private chat", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await sendTelegramFailureNotice({
      kind: "message",
      message: { attachments: [], caption: "", chat: { id: "-100", type: "group" }, messageId: "7", raw: {}, text: "привет" },
    } as never, { code: "AGENT_TELEGRAM_INGRESS_FAILED", dispatchStarted: false, message: "Не удалось" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
