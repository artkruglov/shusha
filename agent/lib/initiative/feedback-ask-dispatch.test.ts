/**
 * Диспетчер вопроса «что мешает»: только суббота днём по времени человека, общее правило инициативы и
 * личное время, предел в четыре вопроса, отказ Telegram заявку не возвращает.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import {
  createFeedbackAskDispatcher, FEEDBACK_ASK_LIMIT, FEEDBACK_ASK_TEXT, type FeedbackAskDispatcherDependencies,
} from "./feedback-ask-dispatch.js";
import type { FeedbackAskRecipient } from "./feedback-ask-repository.js";

// Суббота 24 октября 2026, 14:00 по Москве.
const NOW = new Date("2026-10-24T11:00:00Z");
const person: FeedbackAskRecipient = {
  asked: 0,
  familyId: "family-2",
  settings: { dailyLimit: 3, enabled: true, quietEnd: "08:00", quietStart: "23:00", timezone: "Europe/Moscow" },
  state: { sentToday: 0, unanswered: 0 },
  telegramUserId: "202",
  userId: "user-2",
};

function dependencies(overrides: Partial<FeedbackAskDispatcherDependencies> = {}) {
  return {
    claim: vi.fn().mockResolvedValue("ref-1"),
    personalTime: vi.fn().mockResolvedValue(null),
    recipients: vi.fn().mockResolvedValue([person]),
    record: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("888"),
    ...overrides,
  };
}

describe("feedback ask dispatcher", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks on Saturday afternoon, names the command and journals the question", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies();

    await expect(createFeedbackAskDispatcher(deps)(NOW)).resolves.toBe(1);

    expect(FEEDBACK_ASK_TEXT).toContain("/feedback");
    expect(deps.claim).toHaveBeenCalledWith(person, "2026-10-24", NOW);
    expect(deps.send).toHaveBeenCalledWith({ chatId: "202", text: FEEDBACK_ASK_TEXT });
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      deliveryRef: "ref-1", messageId: "888", sourceKind: "feedback_ask", text: FEEDBACK_ASK_TEXT,
    }));
  });

  it("waits for Saturday afternoon in the person's own zone", async () => {
    for (const at of [
      // Пятница 14:00, суббота 11:00 и 19:00, воскресенье 14:00 по Москве.
      new Date("2026-10-23T11:00:00Z"),
      new Date("2026-10-24T08:00:00Z"),
      new Date("2026-10-24T16:00:00Z"),
      new Date("2026-10-25T11:00:00Z"),
    ]) {
      const deps = dependencies();
      await expect(createFeedbackAskDispatcher(deps)(at)).resolves.toBe(0);
      expect(deps.claim).not.toHaveBeenCalled();
    }
  });

  it("stops after the last question, and obeys the initiative rule and personal time", async () => {
    for (const recipient of [
      { ...person, asked: FEEDBACK_ASK_LIMIT },
      { ...person, settings: { ...person.settings, enabled: false } },
      { ...person, state: { sentToday: 0, unanswered: 3 } },
      { ...person, state: { sentToday: 3, unanswered: 0 } },
    ]) {
      const deps = dependencies({ recipients: vi.fn().mockResolvedValue([recipient]) });
      await expect(createFeedbackAskDispatcher(deps)(NOW)).resolves.toBe(0);
      expect(deps.claim).not.toHaveBeenCalled();
    }
    const busy = dependencies({ personalTime: vi.fn().mockResolvedValue("Бег") });
    await expect(createFeedbackAskDispatcher(busy)(NOW)).resolves.toBe(0);
    expect(busy.claim).not.toHaveBeenCalled();
  });

  it("sends nothing when another tick already claimed the week", async () => {
    const deps = dependencies({ claim: vi.fn().mockResolvedValue(null) });
    await expect(createFeedbackAskDispatcher(deps)(NOW)).resolves.toBe(0);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("keeps the week's claim after a failed delivery and says which kind of failure it was", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = dependencies({
      send: vi.fn().mockRejectedValue(new MemoryReviewOwnerAlertTransportError("failed", "AGENT_X", "403")),
    });
    await expect(createFeedbackAskDispatcher(refused)(NOW)).resolves.toBe(0);
    expect(refused.record).not.toHaveBeenCalled();
    expect(error.mock.calls[0]![0]).toContain("AGENT_FEEDBACK_ASK_FAILED");

    const lost = dependencies({ send: vi.fn().mockRejectedValue(new Error("socket hang up")) });
    await createFeedbackAskDispatcher(lost)(NOW);
    expect(error.mock.calls.at(-1)![0]).toContain("AGENT_FEEDBACK_ASK_AMBIGUOUS");
  });
});
