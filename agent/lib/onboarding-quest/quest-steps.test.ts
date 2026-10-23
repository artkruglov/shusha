/**
 * Шаги знакомства: признаки по фактам, выпадение недоступного, следующий шаг, дни касаний и подписи.
 */
import { describe, expect, it } from "vitest";

import type { FeatureKey } from "../feature-uses/feature-catalog.js";
import {
  availableQuestSteps,
  doneQuestSteps,
  dueQuestTouch,
  nextQuestStep,
  QUEST_STEPS,
  questCardFile,
  questStepByNumber,
  successCaption,
  touchCaption,
  type QuestFacts,
} from "./quest-steps.js";

const ALL = { familyChat: true, grocery: true, images: true };
const OWNER = { familyGroup: false, owner: true };

function facts(overrides: Partial<Omit<QuestFacts, "used">> & { used?: FeatureKey[] } = {}): QuestFacts {
  return { adults: 1, familyGroup: false, voiceTask: false, ...overrides, used: new Set(overrides.used ?? []) };
}

const ids = (steps: readonly { id: string }[]) => steps.map((step) => step.id);

describe("first-steps quest steps", () => {
  it("has eight steps numbered like their cards", () => {
    expect(QUEST_STEPS.map((step) => step.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(ids(QUEST_STEPS)).size).toBe(8);
    expect(ids(QUEST_STEPS).every((id) => /^[a-z0-9_]{1,40}$/u.test(id))).toBe(true);
    expect(questCardFile(questStepByNumber(6)!)).toBe("img/onboarding/quest-6.jpg");
    expect(questStepByNumber(42)).toBeNull();
    // Owner, 23 October 2026: the family together, warm examples; no chores-as-drudgery.
    expect(questStepByNumber(4)!.howTo).toContain("«Купить торт к субботе»");
    expect(QUEST_STEPS.some((step) => /мусор|диспетчер|мужа/iu.test(`${step.title} ${step.howTo}`))).toBe(false);
  });

  it("counts each step from its own fact", () => {
    const steps = availableQuestSteps(ALL, OWNER);
    const doneBy = (one: QuestFacts) => ids(doneQuestSteps(steps, one, new Set()));
    expect(doneBy(facts())).toEqual([]);
    expect(doneBy(facts({ voiceTask: true }))).toEqual(["voice"]);
    expect(doneBy(facts({ adults: 2 }))).toEqual(["family"]);
    expect(doneBy(facts({ familyGroup: true }))).toEqual(["family_chat"]);
    expect(doneBy(facts({ used: ["group_task"] }))).toEqual(["group_task"]);
    expect(doneBy(facts({ used: ["photo"] }))).toEqual(["photo"]);
    expect(doneBy(facts({ used: ["image"] }))).toEqual(["image"]);
    expect(doneBy(facts({ used: ["web_search"] }))).toEqual(["web_search"]);
    expect(doneBy(facts({ used: ["shopping"] }))).toEqual(["shopping"]);
    expect(doneBy(facts({ used: ["grocery"] }))).toEqual(["shopping"]);
    // A voice message alone, or a reminder, is not the voice step; one adult and a child is not a family.
    expect(doneBy(facts({ adults: 1, used: ["voice", "reminder", "chat"] }))).toEqual([]);
  });

  it("keeps a marked step done after its source data is gone", () => {
    const steps = availableQuestSteps(ALL, OWNER);
    expect(ids(doneQuestSteps(steps, facts(), new Set(["photo", "touch_1"])))).toEqual(["photo"]);
  });

  it("drops what the installation does not have instead of leaving it undone", () => {
    expect(ids(availableQuestSteps({ ...ALL, images: false }, OWNER))).not.toContain("image");
    expect(ids(availableQuestSteps({ ...ALL, familyChat: false }, OWNER))).toEqual(
      ["voice", "family", "photo", "image", "web_search", "shopping"]);
    // Shopping stays without the grocery store: the list works everywhere, only the phrase changes.
    const noGrocery = availableQuestSteps({ ...ALL, grocery: false }, OWNER).find((step) => step.id === "shopping")!;
    expect(noGrocery.phrase({ ...ALL, grocery: false })).toBe("Собери продукты на борщ в покупки");
    expect(noGrocery.phrase(ALL)).toContain("ВкусВилле");
  });

  it("does not offer a member the owner's steps, nor the group task without a family chat", () => {
    expect(ids(availableQuestSteps(ALL, { familyGroup: false, owner: false }))).toEqual(
      ["voice", "photo", "image", "web_search", "shopping"]);
    expect(ids(availableQuestSteps(ALL, { familyGroup: true, owner: false }))).toEqual(
      ["voice", "group_task", "photo", "image", "web_search", "shopping"]);
  });

  it("picks the first step not done, in order, and nothing when all are done", () => {
    const steps = availableQuestSteps(ALL, OWNER);
    expect(nextQuestStep(steps, [])?.id).toBe("voice");
    const done = doneQuestSteps(steps, facts({ adults: 2, voiceTask: true, used: ["photo"] }), new Set());
    expect(nextQuestStep(steps, done)?.id).toBe("family_chat");
    expect(nextQuestStep(steps, steps)).toBeNull();
  });

  it("writes the counters into the caption, not onto the card", () => {
    const image = questStepByNumber(6)!;
    expect(successCaption(3, 8, image)).toBe("Получилось ✓ 3 из 8. Дальше — картинка: нарисую открытку");
    expect(touchCaption(0, 7, questStepByNumber(1)!)).toBe("Давайте знакомиться? Первый шаг — голосом: надиктуйте дела на неделю");
    expect(touchCaption(2, 7, image)).toBe("Знакомство: 2 из 7 ✓ Следующий шаг — картинка: нарисую открытку");
  });

  it("touches on days 1, 3 and 7 once each, without stacking missed ones", () => {
    const due = (today: string, marks: string[] = []) => dueQuestTouch({ joinedOn: "2026-10-23", marks: new Set(marks), today });
    expect(due("2026-10-23")).toBeNull();
    expect(due("2026-10-24")).toBe(1);
    expect(due("2026-10-24", ["touch_1"])).toBeNull();
    expect(due("2026-10-25", ["touch_1"])).toBeNull();
    // Day 1 was blocked (quiet hours, a pause): on day 3 only the day 3 touch comes.
    expect(due("2026-10-26")).toBe(3);
    expect(due("2026-10-29", ["touch_1", "touch_3"])).toBeNull();
    expect(due("2026-10-30", ["touch_1", "touch_3"])).toBe(7);
    expect(due("2026-11-01", ["touch_7"])).toBeNull();
    // After the quest days nothing comes, even a touch never sent.
    expect(due("2026-11-02")).toBeNull();
  });
});
