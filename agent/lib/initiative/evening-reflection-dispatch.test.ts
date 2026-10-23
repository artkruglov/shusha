/**
 * Диспетчер итога дня: только 20:00–22:00 по времени человека, общее правило инициативы и личное время, пустой день
 * заявку не тратит, кнопка после заявки, отказ Telegram заявку не возвращает.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import { EVENING_REFLECTION_QUESTION } from "./evening-reflection.js";
import { createEveningReflectionDispatcher, type EveningReflectionDispatcherDependencies } from "./evening-reflection-dispatch.js";
import type { EveningReflectionRecipient } from "./evening-reflection-repository.js";

// Среда 21 октября 2026, 20:30 по Москве.
const NOW = new Date("2026-10-21T17:30:00Z");
const KEYBOARD = { inline_keyboard: [[{ callback_data: "tb:x", text: "Не писать вечером" }]] };
const DAY = { closed: ["Купить хлеб"], first: false, openToday: [], projectLine: null };
const person: EveningReflectionRecipient = {
  coachEnabled: null,
  familyId: "family-1",
  relation: null,
  settings: { dailyLimit: 3, enabled: true, quietEnd: "08:00", quietStart: "23:00", timezone: "Europe/Moscow" },
  state: { sentToday: 0, unanswered: 0 },
  telegramUserId: "101",
  userId: "user-1",
  weeklyReviewEnabled: null,
};

function dependencies(overrides: Partial<EveningReflectionDispatcherDependencies> = {}) {
  return {
    claim: vi.fn().mockResolvedValue("ref-1"),
    content: vi.fn().mockResolvedValue(DAY),
    keyboard: vi.fn().mockResolvedValue(KEYBOARD),
    personalTime: vi.fn().mockResolvedValue(null),
    recipients: vi.fn().mockResolvedValue([person]),
    record: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("777"),
    ...overrides,
  };
}

describe("evening reflection dispatcher", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the day's summary with its button in the evening and journals it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies();
    await expect(createEveningReflectionDispatcher(deps)(NOW)).resolves.toBe(1);
    expect(deps.content).toHaveBeenCalledWith(person, "2026-10-21", NOW);
    expect(deps.claim).toHaveBeenCalledWith(person, "2026-10-21", NOW);
    const sent = vi.mocked(deps.send).mock.calls[0]![0];
    expect(sent).toMatchObject({ chatId: "101", replyMarkup: KEYBOARD });
    expect(sent.text).toContain(EVENING_REFLECTION_QUESTION);
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      deliveryRef: "ref-1", messageId: "777", sourceKind: "evening_reflection", text: sent.text,
    }));
  });

  it("skips only the person whose day could not be read: the others still get theirs", async () => {
    // Ревью 23 октября 2026: исключение до заявки у первого адресата обрывало весь проход.
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const failed = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const other = { ...person, telegramUserId: "102", userId: "user-2" };
    const deps = dependencies({
      content: vi.fn().mockImplementation(async (recipient: EveningReflectionRecipient) => {
        if (recipient.telegramUserId === "101") throw new Error("read failed");
        return DAY;
      }),
      recipients: vi.fn().mockResolvedValue([person, other]),
    });
    await expect(createEveningReflectionDispatcher(deps)(NOW)).resolves.toBe(1);
    expect(vi.mocked(deps.send).mock.calls.map(([sent]) => sent.chatId)).toEqual(["102"]);
    expect(deps.claim).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0]![0]).toContain("AGENT_EVENING_REFLECTION_FAILED");
  });

  it("waits for 20:00–22:00 in the person's own zone", async () => {
    for (const at of [new Date("2026-10-21T16:59:00Z"), new Date("2026-10-21T19:00:00Z"), new Date("2026-10-21T09:00:00Z")]) {
      const deps = dependencies();
      await expect(createEveningReflectionDispatcher(deps)(at)).resolves.toBe(0);
      expect(deps.content).not.toHaveBeenCalled();
    }
  });

  it("keeps the initiative rule and personal time, and an empty day spends no claim", async () => {
    for (const deps of [
      dependencies({ recipients: vi.fn().mockResolvedValue([{ ...person, settings: { ...person.settings, dailyLimit: 0 } }]) }),
      dependencies({ recipients: vi.fn().mockResolvedValue([{ ...person, settings: { ...person.settings, quietStart: "20:00" } }]) }),
      dependencies({ personalTime: vi.fn().mockResolvedValue("Личное время") }),
      dependencies({ content: vi.fn().mockResolvedValue({ ...DAY, closed: [] }) }),
      dependencies({ claim: vi.fn().mockResolvedValue(null) }),
    ]) {
      await expect(createEveningReflectionDispatcher(deps)(NOW)).resolves.toBe(0);
      expect(deps.send).not.toHaveBeenCalled();
    }
    const empty = dependencies({ content: vi.fn().mockResolvedValue({ ...DAY, closed: [] }) });
    await createEveningReflectionDispatcher(empty)(NOW);
    expect(empty.claim).not.toHaveBeenCalled();
  });

  it("logs a refused send without journaling it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies({ send: vi.fn().mockRejectedValue(new MemoryReviewOwnerAlertTransportError("failed", "AGENT_X", "403")) });
    await expect(createEveningReflectionDispatcher(deps)(NOW)).resolves.toBe(0);
    expect(error.mock.calls[0]![0]).toContain("AGENT_EVENING_REFLECTION_FAILED");
    expect(deps.record).not.toHaveBeenCalled();
  });
});
