/**
 * Нажатия под карточкой знакомства: «Попробовать» присылает подсказку с фразой кнопкой внизу один раз, «Позже» ничего
 * не присылает, у семейного чата вместо фразы ссылка.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryAuthorization } from "../memory-context.js";
import { QUEST_TEXT, questStepByNumber } from "../onboarding-quest/quest-steps.js";
import { pressQuestCard, questTryMarkup, type QuestPressDependencies } from "./quest-press.js";
import type { TaskButtonRow } from "./task-button-repository.js";

const NOW = new Date("2026-10-24T11:00:00Z");
const ALL = { familyChat: true, grocery: true, images: true };
const LINK = "https://t.me/yuna_bot?startgroup=family&admin=change_info";
const auth = { familyId: "family-1", groupId: null, role: "owner", scopes: ["personal", "family"], telegramActorId: "101",
  telegramActorKind: "telegram_user", telegramUserId: "101", userId: "user-1" } as MemoryAuthorization;
const row = (action: "quest_later" | "quest_try", tipNumber: number | null = null) => ({
  action, boardQuery: null, chatId: "101", familyId: "family-1", id: "button-1", recipientTelegramId: "101", settled: false,
  settingValue: null, targetGroupId: null, taskId: null, taskVersion: null, tipNumber,
}) as TaskButtonRow & { action: typeof action };

function dependencies(overrides: Partial<QuestPressDependencies> = {}) {
  return {
    availability: () => ALL,
    familyChatLink: () => LINK,
    send: vi.fn().mockResolvedValue("900"),
    spend: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("quest card presses", () => {
  afterEach(() => vi.restoreAllMocks());

  it("«Попробовать» sends the how-to with the phrase as a one-tap button", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies();
    const step = questStepByNumber(7)!;
    await expect(pressQuestCard(deps, { auth, chatId: "101", now: NOW, row: row("quest_try", 7) })).resolves.toBe(QUEST_TEXT.tried);
    expect(deps.spend).toHaveBeenCalledWith("button-1", NOW);
    expect(deps.send).toHaveBeenCalledWith({
      chatId: "101", text: step.howTo,
      replyMarkup: { keyboard: [[{ text: "Где поужинать с детьми рядом?" }]], one_time_keyboard: true, resize_keyboard: true },
    });
  });

  it("sends nothing again on a second tap or a replay", async () => {
    const deps = dependencies({ spend: vi.fn().mockResolvedValue(false) });
    await expect(pressQuestCard(deps, { auth, chatId: "101", now: NOW, row: row("quest_try", 7) })).resolves.toBe(QUEST_TEXT.answered);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("«Позже» only answers, and an unknown step is stale", async () => {
    const deps = dependencies();
    await expect(pressQuestCard(deps, { auth, chatId: "101", now: NOW, row: row("quest_later") })).resolves.toBe(QUEST_TEXT.later);
    await expect(pressQuestCard(deps, { auth, chatId: "101", now: NOW, row: row("quest_try", 77) })).resolves.toBe(QUEST_TEXT.unknown);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.spend).not.toHaveBeenCalled();
  });

  it("refuses a press without a person", async () => {
    await expect(pressQuestCard(dependencies(), { auth: { ...auth, userId: null }, chatId: "101", now: NOW, row: row("quest_try", 1) }))
      .rejects.toMatchObject({ code: "AGENT_ONBOARDING_QUEST_PRESS_FAILED" });
  });

  it("puts the family chat link, not a phrase, under the family chat step, and nothing under voice and photo", () => {
    expect(questTryMarkup(questStepByNumber(3)!, ALL, LINK)).toEqual({
      inline_keyboard: [[{ text: QUEST_TEXT.familyChatButton, url: LINK }]],
    });
    expect(questTryMarkup(questStepByNumber(3)!, ALL, null)).toBeUndefined();
    expect(questTryMarkup(questStepByNumber(1)!, ALL, LINK)).toBeUndefined();
    expect(questTryMarkup(questStepByNumber(5)!, ALL, LINK)).toBeUndefined();
  });
});
