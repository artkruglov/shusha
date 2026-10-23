/**
 * A press under a feature tip or the evening reflection: «Попробовать», «Не интересно», «Не присылать советы»,
 * «Не писать вечером».
 *
 * Exports:
 * - `COACH_TOUCH_ACTIONS`, `isCoachTouchAction`: the actions this module answers.
 * - `CoachTouchPressDependencies`, `coachTouchPressDependencies`: what a press needs; the production set.
 * - `pressCoachTouch`: does the change and returns the line that replaces the buttons.
 *
 * Kept apart from `task-button-callback.ts`, which holds the press path itself. Nothing here acts on a task or asks
 * the model: «Попробовать» sends the tip's fixed «try» text as a new message and records it in the private chat's
 * deliveries (`sourceKind: feature_tip`), so the person's next message reaches a turn that saw both. Only the first
 * answer to a tip counts: a second tap or a replay after a crash sends nothing again. The presser's own user id comes
 * from the live authorization, never from the button; the switches change only the presser's own settings row.
 */
import { AppError } from "../app-error.js";
import { featureTipByNumber } from "../coach-touches/feature-tips.js";
import { featureTipRepository } from "../initiative/feature-tip-repository.js";
import { recordInitiativeDelivery, type InitiativeDelivery } from "../initiative/initiative-delivery.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import type { TaskButtonRow } from "./task-button-repository.js";

export const COACH_TOUCH_ACTIONS = ["tip_try", "tip_dismiss", "tips_off", "evening_off"] as const;
export type CoachTouchAction = typeof COACH_TOUCH_ACTIONS[number];

export function isCoachTouchAction(action: TaskButtonRow["action"]): action is CoachTouchAction {
  return (COACH_TOUCH_ACTIONS as readonly string[]).includes(action);
}

export const COACH_TOUCH_TEXT = {
  answered: "На этот совет вы уже ответили.",
  dismissed: "Хорошо, этот совет пропускаю.",
  eveningOff: "Хорошо, вечером больше не пишу.",
  tipsOff: "Хорошо, подсказок и советов больше не будет.",
  tried: "Попробуем — подсказка ниже.",
  unknownTip: "Этот совет устарел.",
} as const;

export interface CoachTouchPressDependencies {
  answer(input: { now: Date; outcome: "dismissed" | "tried"; tipId: string; userId: string }): Promise<string | null>;
  switchOff(input: { familyId: string; setting: "evening_reflection" | "feature_tips"; userId: string }): Promise<void>;
  send(input: { chatId: string; text: string }): Promise<string>;
  record(delivery: InitiativeDelivery): Promise<void>;
}

export const coachTouchPressDependencies: CoachTouchPressDependencies = {
  answer: (input) => featureTipRepository.answer(input),
  record: recordInitiativeDelivery,
  send: (input) => memoryReviewOwnerAlertTransport.send(input),
  switchOff: (input) => featureTipRepository.switchOff(input),
};

export async function pressCoachTouch(
  dependencies: CoachTouchPressDependencies,
  input: { auth: MemoryAuthorization; chatId: string; now: Date; row: TaskButtonRow & { action: CoachTouchAction } },
): Promise<string> {
  const { auth, row } = input;
  const userId = auth.userId;
  if (userId === null) throw new AppError("AGENT_COACH_TOUCH_PRESS_FAILED", "Не получилось определить, кто нажал кнопку");
  if (row.action === "tips_off" || row.action === "evening_off") {
    await dependencies.switchOff({
      familyId: auth.familyId, setting: row.action === "tips_off" ? "feature_tips" : "evening_reflection", userId,
    });
    return row.action === "tips_off" ? COACH_TOUCH_TEXT.tipsOff : COACH_TOUCH_TEXT.eveningOff;
  }
  const tip = featureTipByNumber(row.tipNumber);
  if (tip === null) return COACH_TOUCH_TEXT.unknownTip;
  const outcome = row.action === "tip_try" ? "tried" : "dismissed";
  const deliveryRef = await dependencies.answer({ now: input.now, outcome, tipId: tip.id, userId });
  if (deliveryRef === null) return COACH_TOUCH_TEXT.answered;
  if (outcome === "dismissed") return COACH_TOUCH_TEXT.dismissed;
  const messageId = await dependencies.send({ chatId: input.chatId, text: tip.tryText });
  try {
    await dependencies.record({
      at: input.now, deliveryRef, familyId: auth.familyId, messageId, sourceKind: "feature_tip",
      telegramUserId: input.chatId, text: tip.tryText, userId,
    });
  } catch (error) {
    // The message went out; only the next turn's context misses it.
    console.error(JSON.stringify({
      code: "AGENT_INITIATIVE_DELIVERY_RECORD_FAILED",
      error: error instanceof Error ? error.message : String(error),
      familyId: auth.familyId,
      sourceKind: "feature_tip",
    }));
  }
  console.info(JSON.stringify({ code: "AGENT_FEATURE_TIP_TRIED", familyId: auth.familyId, tip: tip.id }));
  return COACH_TOUCH_TEXT.tried;
}
