/**
 * Диспетчер «фишки»: только вторник и пятница днём по времени человека, общее правило инициативы и личное время,
 * нет совета — нет заявки, кнопки после заявки, отказ Telegram заявку не возвращает.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { FEATURE_TIP_FIRST_LINE, FEATURE_TIPS } from "../coach-touches/feature-tips.js";
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import { createFeatureTipDispatcher, type FeatureTipDispatcherDependencies } from "./feature-tip-dispatch.js";
import type { FeatureTipRecipient } from "./feature-tip-repository.js";

// Вторник 27 октября 2026, 14:00 по Москве.
const NOW = new Date("2026-10-27T11:00:00Z");
const TIP = FEATURE_TIPS[0]!;
const KEYBOARD = { inline_keyboard: [[{ callback_data: "tb:x", text: "Попробовать" }]] };
const person: FeatureTipRecipient = {
  coachEnabled: null,
  familyId: "family-1",
  relation: null,
  settings: { dailyLimit: 3, enabled: true, quietEnd: "08:00", quietStart: "23:00", timezone: "Europe/Moscow" },
  state: { sentToday: 0, unanswered: 0 },
  telegramUserId: "101",
  userId: "user-1",
  weeklyReviewEnabled: null,
};

function dependencies(overrides: Partial<FeatureTipDispatcherDependencies> = {}) {
  return {
    candidate: vi.fn().mockResolvedValue({ first: false, tip: TIP }),
    claim: vi.fn().mockResolvedValue("ref-1"),
    keyboard: vi.fn().mockResolvedValue(KEYBOARD),
    personalTime: vi.fn().mockResolvedValue(null),
    recipients: vi.fn().mockResolvedValue([person]),
    record: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("555"),
    ...overrides,
  };
}

describe("feature tip dispatcher", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends one tip with its buttons on Tuesday afternoon and journals it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies();
    await expect(createFeatureTipDispatcher(deps)(NOW)).resolves.toBe(1);
    expect(deps.claim).toHaveBeenCalledWith(person, "2026-10-27", TIP, NOW);
    expect(deps.send).toHaveBeenCalledWith({ chatId: "101", replyMarkup: KEYBOARD, text: `💡 ${TIP.text}` });
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      deliveryRef: "ref-1", messageId: "555", sourceKind: "feature_tip", userId: "user-1",
    }));
  });

  it("explains itself the first time", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies({ candidate: vi.fn().mockResolvedValue({ first: true, tip: TIP }) });
    await createFeatureTipDispatcher(deps)(NOW);
    expect(vi.mocked(deps.send).mock.calls[0]![0].text.startsWith(FEATURE_TIP_FIRST_LINE)).toBe(true);
  });

  it("waits for Tuesday or Friday afternoon in the person's own zone", async () => {
    for (const at of [
      new Date("2026-10-26T11:00:00Z"), // понедельник 14:00
      new Date("2026-10-27T08:00:00Z"), // вторник 11:00
      new Date("2026-10-27T16:00:00Z"), // вторник 19:00
      new Date("2026-10-31T11:00:00Z"), // суббота 14:00
    ]) {
      const deps = dependencies();
      await expect(createFeatureTipDispatcher(deps)(at)).resolves.toBe(0);
      expect(deps.claim).not.toHaveBeenCalled();
    }
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    await expect(createFeatureTipDispatcher(dependencies())(new Date("2026-10-30T13:00:00Z"))).resolves.toBe(1);
  });

  it("keeps the initiative rule, personal time and an empty catalog", async () => {
    for (const deps of [
      dependencies({ recipients: vi.fn().mockResolvedValue([{ ...person, settings: { ...person.settings, enabled: false } }]) }),
      dependencies({ recipients: vi.fn().mockResolvedValue([{ ...person, state: { sentToday: 0, unanswered: 3 } }]) }),
      dependencies({ personalTime: vi.fn().mockResolvedValue("Личное время") }),
      dependencies({ candidate: vi.fn().mockResolvedValue(null) }),
      dependencies({ claim: vi.fn().mockResolvedValue(null) }),
    ]) {
      await expect(createFeatureTipDispatcher(deps)(NOW)).resolves.toBe(0);
      expect(deps.send).not.toHaveBeenCalled();
    }
  });

  it("logs a refused or ambiguous send without retrying", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = dependencies({ send: vi.fn().mockRejectedValue(new MemoryReviewOwnerAlertTransportError("failed", "AGENT_X", "403")) });
    await expect(createFeatureTipDispatcher(refused)(NOW)).resolves.toBe(0);
    expect(error.mock.calls[0]![0]).toContain("AGENT_FEATURE_TIP_FAILED");
    const ambiguous = dependencies({ send: vi.fn().mockRejectedValue(new Error("timeout")) });
    await createFeatureTipDispatcher(ambiguous)(NOW);
    expect(error.mock.calls[1]![0]).toContain("AGENT_FEATURE_TIP_AMBIGUOUS");
    expect(refused.record).not.toHaveBeenCalled();
  });
});
