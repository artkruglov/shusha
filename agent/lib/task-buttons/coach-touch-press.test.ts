/**
 * Нажатия под «фишкой» и итогом дня: «Попробовать» присылает текст попытки и пишет его в журнал доставок только на
 * первый ответ, «Не интересно» ничего не присылает, выключатели меняют только строку нажавшего.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { featureTipByNumber } from "../coach-touches/feature-tips.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { COACH_TOUCH_TEXT, pressCoachTouch, type CoachTouchPressDependencies } from "./coach-touch-press.js";
import type { TaskButtonRow } from "./task-button-repository.js";

const NOW = new Date("2026-10-27T11:00:00Z");
const auth = { familyId: "family-1", groupId: null, role: "member", scopes: ["personal", "family"], telegramActorId: "101",
  telegramActorKind: "telegram_user", telegramUserId: "101", userId: "user-1" } as MemoryAuthorization;
const row = (action: "evening_off" | "tip_dismiss" | "tip_try" | "tips_off", tipNumber: number | null = null) => ({
  action, boardQuery: null, chatId: "101", familyId: "family-1", id: "button-1", recipientTelegramId: "101", settled: false,
  settingValue: null, targetGroupId: null, taskId: null, taskVersion: null, tipNumber,
}) as TaskButtonRow & { action: typeof action };

function dependencies(overrides: Partial<CoachTouchPressDependencies> = {}) {
  return {
    answer: vi.fn().mockResolvedValue("ref-1"),
    record: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("900"),
    switchOff: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("coach touch presses", () => {
  afterEach(() => vi.restoreAllMocks());

  it("«Попробовать» sends the try text once and journals it under the tip's claim", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies();
    const tip = featureTipByNumber(1)!;
    await expect(pressCoachTouch(deps, { auth, chatId: "101", now: NOW, row: row("tip_try", 1) })).resolves.toBe(COACH_TOUCH_TEXT.tried);
    expect(deps.answer).toHaveBeenCalledWith({ now: NOW, outcome: "tried", tipId: tip.id, userId: "user-1" });
    expect(deps.send).toHaveBeenCalledWith({ chatId: "101", text: tip.tryText });
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      deliveryRef: "ref-1", messageId: "900", sourceKind: "feature_tip", text: tip.tryText, userId: "user-1",
    }));

    const again = dependencies({ answer: vi.fn().mockResolvedValue(null) });
    await expect(pressCoachTouch(again, { auth, chatId: "101", now: NOW, row: row("tip_try", 1) })).resolves.toBe(COACH_TOUCH_TEXT.answered);
    expect(again.send).not.toHaveBeenCalled();
  });

  it("«Не интересно» marks the tip and sends nothing", async () => {
    const deps = dependencies();
    await expect(pressCoachTouch(deps, { auth, chatId: "101", now: NOW, row: row("tip_dismiss", 10) })).resolves.toBe(COACH_TOUCH_TEXT.dismissed);
    expect(deps.answer).toHaveBeenCalledWith(expect.objectContaining({ outcome: "dismissed", tipId: "skin" }));
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("the switches turn off only the presser's own setting", async () => {
    const deps = dependencies();
    await expect(pressCoachTouch(deps, { auth, chatId: "101", now: NOW, row: row("tips_off") })).resolves.toBe(COACH_TOUCH_TEXT.tipsOff);
    await expect(pressCoachTouch(deps, { auth, chatId: "101", now: NOW, row: row("evening_off") })).resolves.toBe(COACH_TOUCH_TEXT.eveningOff);
    expect(vi.mocked(deps.switchOff).mock.calls.map(([input]) => input)).toEqual([
      { familyId: "family-1", setting: "feature_tips", userId: "user-1" },
      { familyId: "family-1", setting: "evening_reflection", userId: "user-1" },
    ]);
  });

  it("a tip number the catalog no longer has is answered, not thrown", async () => {
    const deps = dependencies();
    await expect(pressCoachTouch(deps, { auth, chatId: "101", now: NOW, row: row("tip_try", 98) })).resolves.toBe(COACH_TOUCH_TEXT.unknownTip);
    expect(deps.answer).not.toHaveBeenCalled();
  });
});
