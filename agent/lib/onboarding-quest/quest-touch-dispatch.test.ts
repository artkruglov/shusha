/**
 * Касания знакомства: день 1, 3, 7 днём по времени человека, через общее правило инициативы, одно на день касания.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InitiativeRecipient } from "../initiative/initiative-audience.js";
import type { QuestPerson } from "./quest-repository.js";
import type { QuestFacts } from "./quest-steps.js";
import { createQuestTouchDispatcher, type QuestTouchDependencies } from "./quest-touch-dispatch.js";

// 14:00 in Moscow, the day after joining.
const NOW = new Date("2026-10-24T11:00:00Z");
const MARKUP = { inline_keyboard: [[{ callback_data: "tb:x", text: "Попробовать" }]] };

function recipient(overrides: Partial<InitiativeRecipient> = {}): InitiativeRecipient {
  return {
    coachEnabled: null, familyId: "family-1", relation: null,
    settings: { dailyLimit: 3, enabled: true, quietEnd: null, quietStart: null, timezone: "Europe/Moscow" },
    state: { sentToday: 0, unanswered: 0 }, telegramUserId: "101", userId: "user-1", weeklyReviewEnabled: null, ...overrides,
  };
}

function person(overrides: Partial<QuestPerson> = {}): QuestPerson {
  return {
    active: true, familyId: "family-1", joinedAt: new Date("2026-10-23T09:00:00Z"), marks: new Set(), owner: true,
    telegramUserId: "101", timezone: "Europe/Moscow", userId: "user-1", ...overrides,
  };
}

const FACTS: QuestFacts = { adults: 1, familyGroup: false, used: new Set(["photo"]), voiceTask: true };

function dependencies(overrides: Partial<QuestTouchDependencies> = {}) {
  return {
    availability: () => ({ familyChat: true, grocery: false, images: true }),
    card: vi.fn().mockResolvedValue("900"),
    claim: vi.fn().mockResolvedValue("ref-1"),
    facts: vi.fn().mockResolvedValue(FACTS),
    keyboard: vi.fn().mockResolvedValue(MARKUP),
    mark: vi.fn().mockResolvedValue(new Set()),
    person: vi.fn().mockResolvedValue(person()),
    personalTime: vi.fn().mockResolvedValue(null),
    recipients: vi.fn().mockResolvedValue([recipient()]),
    record: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("quest touches", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the day 1 card with the next step and journals it under the claim", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies();
    await expect(createQuestTouchDispatcher(deps)(NOW)).resolves.toBe(1);
    // Done steps are counted silently: the touch shows them, the next turn does not congratulate on them.
    expect(deps.mark).toHaveBeenCalledWith(expect.anything(), ["voice", "photo"], NOW);
    expect(deps.claim).toHaveBeenCalledWith(expect.anything(), "2026-10-24", 1, NOW);
    const caption = "Знакомство: 2 из 8 ✓ Следующий шаг — семья: позовите близкого";
    expect(deps.card).toHaveBeenCalledWith({ caption, chatId: "101", replyMarkup: MARKUP, step: expect.objectContaining({ id: "family" }) });
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      deliveryRef: "ref-1", messageId: "900", sourceKind: "feature_tip", text: caption, userId: "user-1",
    }));
  });

  it("goes through the initiative rule: off, quiet hours and the pause after silence stop it", async () => {
    for (const blocked of [
      recipient({ settings: { ...recipient().settings, enabled: false } }),
      recipient({ settings: { ...recipient().settings, quietEnd: "23:00", quietStart: "13:00" } }),
      recipient({ state: { sentToday: 0, unanswered: 3 } }),
      recipient({ state: { sentToday: 3, unanswered: 0 } }),
    ]) {
      const deps = dependencies({ recipients: vi.fn().mockResolvedValue([blocked]) });
      await expect(createQuestTouchDispatcher(deps)(NOW)).resolves.toBe(0);
      expect(deps.claim).not.toHaveBeenCalled();
    }
  });

  it("waits for the afternoon and for the person's own time", async () => {
    const night = dependencies();
    await expect(createQuestTouchDispatcher(night)(new Date("2026-10-24T04:00:00Z"))).resolves.toBe(0);
    const busy = dependencies({ personalTime: vi.fn().mockResolvedValue("Тренировка") });
    await expect(createQuestTouchDispatcher(busy)(NOW)).resolves.toBe(0);
    expect(busy.person).not.toHaveBeenCalled();
  });

  it("does not touch on the joining day, twice on one touch day, out of the quest or with nothing left", async () => {
    const sameDay = dependencies({ person: vi.fn().mockResolvedValue(person({ joinedAt: new Date("2026-10-24T06:00:00Z") })) });
    await expect(createQuestTouchDispatcher(sameDay)(NOW)).resolves.toBe(0);
    const touched = dependencies({ person: vi.fn().mockResolvedValue(person({ marks: new Set(["touch_1"]) })) });
    await expect(createQuestTouchDispatcher(touched)(NOW)).resolves.toBe(0);
    const out = dependencies({ person: vi.fn().mockResolvedValue(person({ active: false })) });
    await expect(createQuestTouchDispatcher(out)(NOW)).resolves.toBe(0);
    const all = dependencies({ facts: vi.fn().mockResolvedValue({
      adults: 2, familyGroup: true, used: new Set(["group_task", "photo", "image", "web_search", "shopping"]), voiceTask: true,
    }) });
    await expect(createQuestTouchDispatcher(all)(NOW)).resolves.toBe(0);
    expect(all.claim).not.toHaveBeenCalled();
    const claimed = dependencies({ claim: vi.fn().mockResolvedValue(null) });
    await expect(createQuestTouchDispatcher(claimed)(NOW)).resolves.toBe(0);
    expect(claimed.card).not.toHaveBeenCalled();
  });

  it("logs a failed send and goes on to the next person", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies({
      card: vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue("901"),
      recipients: vi.fn().mockResolvedValue([recipient(), recipient({ userId: "user-2" })]),
    });
    await expect(createQuestTouchDispatcher(deps)(NOW)).resolves.toBe(1);
    expect(errors.mock.calls[0]?.[0]).toContain("AGENT_ONBOARDING_QUEST_AMBIGUOUS");
  });
});
