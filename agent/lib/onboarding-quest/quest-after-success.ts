/**
 * Следующий шаг знакомства сразу после успеха: карточку шлёт код, а не модель.
 *
 * Экспорт:
 * - `questProgress`: шаги человека на сервере, сделанные и следующий.
 * - `QuestAfterSuccessDependencies`, `createQuestAfterSuccess`: проверка и отправка с подменяемыми зависимостями.
 * - `questTurnActor`: человек личного хода, после которого стоит проверить знакомство, или null.
 *
 * После хода в личке (или нажатия «Беру»/«Сделано» в семейном чате) читаются признаки шагов. Шаг, ставший сделанным
 * впервые, отмечается (`onboarding_quest_marks`), и только тогда уходит одно сообщение: карточка следующего
 * непройденного шага с «Получилось ✓ N из M» и кнопками, а если непройденных нет — финал, после которого знакомство
 * закончено. Отметка ставится до отправки и только один раз: соседний ход или повтор события не шлют второе
 * сообщение, а сбой Telegram теряет одно поздравление, но не повторяет его. Не для гостевой зоны и внешних групп:
 * сообщение уходит только в личный чат человека с ботом.
 */
import type { SessionAuth } from "eve/context";

import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import { isMemoryReviewSession } from "../memory-review/memory-review-session.js";
import type { QuestPerson } from "./quest-repository.js";
import {
  availableQuestSteps,
  doneQuestSteps,
  nextQuestStep,
  QUEST_TEXT,
  successCaption,
  type QuestAvailability,
  type QuestFacts,
  type QuestStep,
} from "./quest-steps.js";
import type { QuestReplyMarkup } from "./quest-transport.js";

export function questProgress(person: Pick<QuestPerson, "marks" | "owner">, facts: QuestFacts, availability: QuestAvailability) {
  const steps = availableQuestSteps(availability, { familyGroup: facts.familyGroup, owner: person.owner });
  const done = doneQuestSteps(steps, facts, person.marks);
  return { done, next: nextQuestStep(steps, done), steps };
}

export interface QuestAfterSuccessDependencies {
  availability(): QuestAvailability;
  person(input: { familyId: string; now: Date; userId: string }): Promise<QuestPerson | null>;
  facts(person: QuestPerson): Promise<QuestFacts>;
  mark(person: QuestPerson, marks: readonly string[], now: Date): Promise<Set<string>>;
  keyboard(person: QuestPerson, step: QuestStep, now: Date): Promise<QuestReplyMarkup>;
  card(input: { caption: string; chatId: string; replyMarkup: QuestReplyMarkup; step: QuestStep }): Promise<string>;
  text(input: { chatId: string; text: string }): Promise<string>;
}

export type QuestAfterSuccessResult = "card" | "final" | null;

export function createQuestAfterSuccess(dependencies: QuestAfterSuccessDependencies) {
  return async function advanceQuest(actor: { familyId: string; userId: string }, now = new Date()): Promise<QuestAfterSuccessResult> {
    const person = await dependencies.person({ ...actor, now });
    if (person === null || !person.active) return null;
    const facts = await dependencies.facts(person);
    const { done, next, steps } = questProgress(person, facts, dependencies.availability());
    const fresh = done.filter((step) => !person.marks.has(step.id)).map((step) => step.id);
    if (fresh.length === 0) return null;
    // Only the turn that set a mark speaks: a racing turn or a replayed event finds them set.
    if ((await dependencies.mark(person, fresh, now)).size === 0) return null;
    const chatId = person.telegramUserId;
    if (next === null) {
      if (!(await dependencies.mark(person, ["final"], now)).has("final")) return null;
      await dependencies.text({ chatId, text: QUEST_TEXT.final });
      console.info(JSON.stringify({ code: "AGENT_ONBOARDING_QUEST_FINISHED", familyId: person.familyId }));
      return "final";
    }
    const replyMarkup = await dependencies.keyboard(person, next, now);
    await dependencies.card({ caption: successCaption(done.length, steps.length, next), chatId, replyMarkup, step: next });
    console.info(JSON.stringify({
      code: "AGENT_ONBOARDING_QUEST_STEP_DONE", done: done.length, familyId: person.familyId, next: next.id, total: steps.length,
    }));
    return "card";
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Только собственный личный чат человека: не группа, не расписание, не тихая проверка памяти, не другой бот. */
export function questTurnActor(ctx: { session: { auth: SessionAuth; id: string } }): { familyId: string; userId: string } | null {
  if (isScheduledSession(ctx) || isMemoryReviewSession(ctx)) return null;
  const current = ctx.session.auth.current;
  const attributes = current?.attributes;
  if (current?.authenticator !== "telegram" || !attributes) return null;
  if (attributes.telegramChatType !== "private" || typeof attributes.groupId === "string") return null;
  const familyId = attributes.familyId;
  const userId = current.principalId;
  if (typeof familyId !== "string" || typeof userId !== "string" || !UUID.test(userId)) return null;
  return { familyId, userId };
}
