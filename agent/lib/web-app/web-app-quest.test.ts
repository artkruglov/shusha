/**
 * «Знакомство» in the Mini App (`web-app-quest.ts`).
 *
 * Covered: the ring shows done/total in the person's order and disappears once hidden or past the quest; «Попробовать
 * в чате» sends the card of an open, offered step only; «Скрыть» marks only the app.
 */
import { describe, expect, it, vi } from "vitest";

import type { MemoryAuthorization } from "../memory-context.js";
import type { QuestPerson } from "../onboarding-quest/quest-repository.js";
import type { QuestFacts } from "../onboarding-quest/quest-steps.js";
import { createWebAppQuest } from "./web-app-quest.js";

const auth = { familyId: "f1", userId: "u1" } as MemoryAuthorization;
const now = new Date("2026-10-24T10:00:00Z");
const facts = (over: Partial<QuestFacts> = {}) => ({
  adults: 1, familyGroup: false, used: new Set<string>(), voiceTask: false, ...over,
}) as unknown as QuestFacts;

function quest(person: Partial<QuestPerson> = {}, factsOver: Partial<QuestFacts> = {}) {
  const card = vi.fn().mockResolvedValue("1");
  const mark = vi.fn().mockResolvedValue(new Set(["app_hidden"]));
  const api = createWebAppQuest({
    availability: () => ({ grocery: true, images: true }) as never,
    card,
    facts: async () => facts(factsOver),
    keyboard: vi.fn().mockResolvedValue({ inline_keyboard: [] }) as never,
    mark,
    person: async () => ({
      active: true, familyId: "f1", joinedAt: now, marks: new Set<string>(), owner: true, telegramUserId: "101",
      timezone: "UTC", userId: "u1", ...person,
    }),
  });
  return { api, card, mark };
}

describe("web app quest", () => {
  it("shows progress in order and hides once the person hid it or left the quest", async () => {
    const { api } = quest({}, { voiceTask: true });
    const ring = await api.read(auth, now);
    expect(ring?.done).toBe(1);
    expect(ring?.steps[0]).toMatchObject({ done: true, number: 1 });
    expect(ring?.steps[0]?.title.charAt(0)).toBe(ring?.steps[0]?.title.charAt(0).toUpperCase());
    expect(await quest({ marks: new Set(["app_hidden"]) }).api.read(auth, now)).toBeNull();
    expect(await quest({ active: false }).api.read(auth, now)).toBeNull();
  });

  it("sends the card of an open step to the private chat and refuses a done one", async () => {
    const { api, card } = quest({}, { voiceTask: true });
    await expect(api.tryStep(auth, 1, now)).rejects.toThrow();
    await api.tryStep(auth, 2, now);
    expect(card).toHaveBeenCalledWith(expect.objectContaining({ chatId: "101", step: expect.objectContaining({ number: 2 }) }));
  });

  it("refuses an owner-only step for a member and hides only the app ring", async () => {
    const { api, mark } = quest({ owner: false });
    await expect(api.tryStep(auth, 2, now)).rejects.toThrow();
    await api.hide(auth, now);
    expect(mark).toHaveBeenCalledWith(expect.anything(), ["app_hidden"], now);
  });
});
