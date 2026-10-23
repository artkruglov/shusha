/**
 * A press under a step card of the first-steps quest: «Попробовать» and «Позже» (migration 197).
 *
 * Exports:
 * - `QUEST_ACTIONS`, `isQuestAction`: the actions this module answers.
 * - `QuestPressDependencies`, `questPressDependencies`: what a press needs; the production set.
 * - `questTryMarkup`: what goes under the how-to of a step: its phrase as a one-tap button, or the family chat link.
 * - `pressQuestCard`: does the press and returns the line answered under the finger.
 *
 * «Хватит подсказок» is the feature tips' own `tips_off` (`coach-touch-press.ts`): the quest reads the same switch.
 * Nothing here asks the model: «Попробовать» sends the step's fixed how-to with its phrase as a reply keyboard
 * button, so one tap is an ordinary message of the person and gives a real result. The button is spent on the first
 * press: a second tap or a replay after a crash sends nothing again. The presser comes from the live authorization.
 */
import { AppError } from "../app-error.js";
import { familyChatLink } from "../groups-availability.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { questRepository } from "../onboarding-quest/quest-repository.js";
import { QUEST_TEXT, questStepByNumber, type QuestAvailability, type QuestStep } from "../onboarding-quest/quest-steps.js";
import { questTransport, type QuestReplyMarkup } from "../onboarding-quest/quest-transport.js";
import { questAvailability } from "../onboarding-quest/quest-availability.js";
import type { TaskButtonRow } from "./task-button-repository.js";

export const QUEST_ACTIONS = ["quest_try", "quest_later"] as const;
export type QuestAction = typeof QUEST_ACTIONS[number];

export function isQuestAction(action: TaskButtonRow["action"]): action is QuestAction {
  return (QUEST_ACTIONS as readonly string[]).includes(action);
}

export interface QuestPressDependencies {
  availability(): QuestAvailability;
  familyChatLink(): string | null;
  send(input: { chatId: string; replyMarkup?: QuestReplyMarkup; text: string }): Promise<string>;
  /** True once per button. */
  spend(buttonId: string, now: Date): Promise<boolean>;
}

export const questPressDependencies: QuestPressDependencies = {
  availability: questAvailability,
  familyChatLink: () => familyChatLink(process.env.TELEGRAM_BOT_USERNAME),
  send: (input) => questTransport.text(input),
  spend: (buttonId, now) => questRepository.spendButton(buttonId, now),
};

export function questTryMarkup(step: QuestStep, availability: QuestAvailability, chatLink: string | null): QuestReplyMarkup | undefined {
  if (step.id === "family_chat") {
    return chatLink === null ? undefined : { inline_keyboard: [[{ text: QUEST_TEXT.familyChatButton, url: chatLink }]] };
  }
  const phrase = step.phrase(availability);
  return phrase === null ? undefined : { keyboard: [[{ text: phrase }]], one_time_keyboard: true, resize_keyboard: true };
}

export async function pressQuestCard(
  dependencies: QuestPressDependencies,
  input: { auth: MemoryAuthorization; chatId: string; now: Date; row: TaskButtonRow & { action: QuestAction } },
): Promise<string> {
  const { auth, row } = input;
  if (auth.userId === null) throw new AppError("AGENT_ONBOARDING_QUEST_PRESS_FAILED", "Не получилось определить, кто нажал кнопку");
  if (row.action === "quest_later") return QUEST_TEXT.later;
  const step = questStepByNumber(row.tipNumber);
  if (step === null) return QUEST_TEXT.unknown;
  if (!await dependencies.spend(row.id, input.now)) return QUEST_TEXT.answered;
  const replyMarkup = questTryMarkup(step, dependencies.availability(), dependencies.familyChatLink());
  await dependencies.send({ chatId: input.chatId, text: step.howTo, ...(replyMarkup ? { replyMarkup } : {}) });
  console.info(JSON.stringify({ code: "AGENT_ONBOARDING_QUEST_TRIED", familyId: auth.familyId, step: step.id }));
  return QUEST_TEXT.tried;
}
