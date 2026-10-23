/**
 * После успеха: одна карточка следующего шага на впервые сделанный шаг, финал, когда сделано всё, и только личный ход.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FeatureKey } from "../feature-uses/feature-catalog.js";
import { createQuestAfterSuccess, questTurnActor, type QuestAfterSuccessDependencies } from "./quest-after-success.js";
import type { QuestPerson } from "./quest-repository.js";
import { QUEST_TEXT, type QuestFacts } from "./quest-steps.js";

const NOW = new Date("2026-10-24T12:00:00Z");
const USER = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const MARKUP = { inline_keyboard: [[{ callback_data: "tb:x", text: "Попробовать" }]] };

function person(overrides: Partial<QuestPerson> = {}): QuestPerson {
  return {
    active: true, familyId: "family-1", joinedAt: new Date("2026-10-23T10:00:00Z"), marks: new Set(), owner: true,
    telegramUserId: "101", timezone: "Europe/Moscow", userId: USER, ...overrides,
  };
}

function facts(used: FeatureKey[] = [], overrides: Partial<QuestFacts> = {}): QuestFacts {
  return { adults: 1, familyGroup: false, voiceTask: false, used: new Set(used), ...overrides };
}

function dependencies(input: { facts?: QuestFacts; person?: QuestPerson | null } = {}) {
  const marked = new Set<string>(input.person?.marks ?? []);
  return {
    availability: () => ({ familyChat: true, grocery: false, images: true }),
    card: vi.fn().mockResolvedValue("900"),
    facts: vi.fn().mockResolvedValue(input.facts ?? facts()),
    keyboard: vi.fn().mockResolvedValue(MARKUP),
    // Like the table: a mark is new only once.
    mark: vi.fn(async (_person: QuestPerson, marks: readonly string[]) => {
      const fresh = marks.filter((mark) => !marked.has(mark));
      for (const mark of fresh) marked.add(mark);
      return new Set(fresh);
    }),
    person: vi.fn().mockResolvedValue(input.person === undefined ? person() : input.person),
    text: vi.fn().mockResolvedValue("901"),
  } satisfies QuestAfterSuccessDependencies;
}

describe("quest after a success", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the next step card once when a step is newly done", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies({ facts: facts([], { voiceTask: true }) });
    const advance = createQuestAfterSuccess(deps);
    await expect(advance({ familyId: "family-1", userId: USER }, NOW)).resolves.toBe("card");
    expect(deps.mark).toHaveBeenCalledWith(expect.anything(), ["voice"], NOW);
    expect(deps.card).toHaveBeenCalledWith({
      caption: "Получилось ✓ 1 из 8. Дальше — семья: позовите близкого", chatId: "101", replyMarkup: MARKUP,
      step: expect.objectContaining({ id: "family" }),
    });
    // The same turn event replayed, or the next turn without anything new: no second card.
    await expect(advance({ familyId: "family-1", userId: USER }, NOW)).resolves.toBeNull();
    expect(deps.card).toHaveBeenCalledTimes(1);
  });

  it("says nothing when nothing new was done", async () => {
    const deps = dependencies({ facts: facts(["photo"]), person: person({ marks: new Set(["photo"]) }) });
    await expect(createQuestAfterSuccess(deps)({ familyId: "family-1", userId: USER }, NOW)).resolves.toBeNull();
    expect(deps.mark).not.toHaveBeenCalled();
    expect(deps.card).not.toHaveBeenCalled();
  });

  it("stays silent for someone out of the quest", async () => {
    const deps = dependencies({ facts: facts(["photo"]), person: person({ active: false }) });
    await expect(createQuestAfterSuccess(deps)({ familyId: "family-1", userId: USER }, NOW)).resolves.toBeNull();
    expect(deps.facts).not.toHaveBeenCalled();
    const gone = dependencies({ person: null });
    await expect(createQuestAfterSuccess(gone)({ familyId: "family-1", userId: USER }, NOW)).resolves.toBeNull();
  });

  it("closes the quest with the final line when the last step is done, once", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const everything = facts(["group_task", "photo", "image", "web_search", "shopping"], { adults: 2, familyGroup: true, voiceTask: true });
    const deps = dependencies({
      facts: everything,
      person: person({ marks: new Set(["voice", "family", "family_chat", "group_task", "photo", "image", "web_search"]) }),
    });
    const advance = createQuestAfterSuccess(deps);
    await expect(advance({ familyId: "family-1", userId: USER }, NOW)).resolves.toBe("final");
    expect(deps.text).toHaveBeenCalledWith({ chatId: "101", text: QUEST_TEXT.final });
    expect(deps.card).not.toHaveBeenCalled();
    expect(deps.mark).toHaveBeenLastCalledWith(expect.anything(), ["final"], NOW);
  });

  it("counts only the steps of a member, who joined a ready family", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies({ facts: facts(["web_search"], { adults: 2, familyGroup: true }), person: person({ owner: false }) });
    await createQuestAfterSuccess(deps)({ familyId: "family-1", userId: USER }, NOW);
    expect(deps.mark).toHaveBeenCalledWith(expect.anything(), ["web_search"], NOW);
    expect(deps.card).toHaveBeenCalledWith(expect.objectContaining({
      caption: "Получилось ✓ 1 из 6. Дальше — голосом: надиктуйте дела на неделю",
    }));
  });
});

describe("quest turn actor", () => {
  const ctx = (attributes: Record<string, unknown>, principalId = USER) => ({
    session: { auth: { current: { attributes, authenticator: "telegram", principalId } }, id: "session-1" },
  }) as never;

  it("is the person of their own private chat", () => {
    expect(questTurnActor(ctx({ familyId: "family-1", telegramChatType: "private" }))).toEqual({ familyId: "family-1", userId: USER });
  });

  it("is nobody in a group, for another bot or without a family", () => {
    expect(questTurnActor(ctx({ familyId: "family-1", groupId: "group-1", telegramChatType: "supergroup" }))).toBeNull();
    expect(questTurnActor(ctx({ familyId: "family-1", telegramChatType: "private" }, "telegram-bot:42"))).toBeNull();
    expect(questTurnActor(ctx({ telegramChatType: "private" }))).toBeNull();
  });
});
