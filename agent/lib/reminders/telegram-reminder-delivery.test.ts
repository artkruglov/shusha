/**
 * Proactive Telegram reminder delivery tests.
 *
 * Constructs covered:
 * - Deterministic delayed text and forum-topic targeting.
 * - Provider rejection and timeout errors propagate to the durable dispatcher.
 * - A chat Telegram calls gone fails with the stable unreachable code and reason.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaimedReminder } from "./reminder-dispatch-repository.js";
import { deliverTelegramReminder } from "./telegram-reminder-delivery.js";

const delayedJob: ClaimedReminder = {
  familyId: "00000000-0000-4000-8000-000000000010",
  forumTopicId: "77",
  content: "Собрать документы",
  delayed: true,
  dueAt: "2026-07-13T06:00:00.000Z",
  id: "00000000-0000-4000-8000-000000000001",
  leaseToken: "00000000-0000-4000-8000-000000000002",
  messageThreadId: "77",
  groupId: "00000000-0000-4000-8000-000000000012",
  ownerUserId: null,
  scope: "family",
  telegramChatId: "-1001",
  timezone: "Europe/Moscow",
};

describe("deliverTelegramReminder", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends delayed reminder text to the persisted chat and topic", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: { chat: { id: -1001, type: "supergroup" }, message_id: 55 },
    }), { status: 200 }));

    await expect(deliverTelegramReminder(delayedJob)).resolves.toEqual({
      messageId: "55",
      text: [
        "Напоминание:",
        "Собрать документы",
        "Доставлено с задержкой. Изначальное время: 13 июл. 2026 г., 09:00 (Europe/Moscow).",
      ].join("\n\n"),
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(request?.body))).toEqual({
      chat_id: "-1001",
      message_thread_id: 77,
      text: [
        "Напоминание:",
        "Собрать документы",
        "Доставлено с задержкой. Изначальное время: 13 июл. 2026 г., 09:00 (Europe/Moscow).",
      ].join("\n\n"),
    });
  });
  it("labels a response check as a request to its author",async()=>{
    vi.stubEnv("TELEGRAM_BOT_TOKEN","telegram-bot-secret");
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:true,result:{chat:{id:902,type:"private"},message_id:56}}),{status:200})));
    const receipt=await deliverTelegramReminder({...delayedJob,delayed:false,taskReminderKind:"response",scope:"personal",groupId:null,
      messageThreadId:null,forumTopicId:null,telegramChatId:"902",ownerUserId:"00000000-0000-4000-8000-000000000011"});
    expect(receipt.text).toBe("Проверить ответ на вашу просьбу:\n\nСобрать документы");
  });

  it.each([
    new Response("{}", { status: 503 }),
    new DOMException("timed out", "TimeoutError"),
  ])("propagates provider failure %s", async (failure) => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        failure instanceof Response ? Promise.resolve(failure) : Promise.reject(failure)
      ),
    );

    await expect(deliverTelegramReminder(delayedJob)).rejects.toBeDefined();
  });

  it("names a bot removed from the group with the stable unreachable code, without the reminder text in the log", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      description: "Forbidden: bot was kicked from the supergroup chat", error_code: 403, ok: false,
    }), { status: 403 })));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(deliverTelegramReminder(delayedJob)).rejects.toMatchObject({
      chatId: "-1001", code: "AGENT_TELEGRAM_RECIPIENT_UNREACHABLE", reason: "kicked",
    });
    expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toMatchObject({ code: "AGENT_TELEGRAM_RECIPIENT_UNREACHABLE" });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("Собрать документы");
    errors.mockRestore();
  });
});
