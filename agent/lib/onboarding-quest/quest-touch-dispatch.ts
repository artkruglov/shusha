/**
 * Касание знакомства, если человек молчит: одно в 1, 3 и 7 день после входа, карточка следующего шага.
 *
 * Экспорт:
 * - `QUEST_TOUCH_FIRST_HOUR`, `QUEST_TOUCH_LAST_HOUR`: днём по времени человека.
 * - `QuestTouchDependencies`, `createQuestTouchDispatcher`: диспетчер с подменяемыми зависимостями.
 *
 * Порядок тот же, что у «фишки» (`feature-tip-dispatch.ts`): общее правило инициативы (выключатель «не пиши мне
 * первым», тихие часы, пауза после трёх неотвеченных, предел суток), личное время, затем день касания, шаг-кандидат,
 * заявка вместе с отметкой дня, кнопки, отправка, журнал доставок. Сделанные к этому моменту шаги отмечаются молча:
 * поздравлять в касании не с чем, а следующий ход не должен поздравлять с давним. Нечего предложить — нет и сообщения.
 */
import { decideInitiative } from "../initiative/initiative-policy.js";
import type { InitiativeDelivery } from "../initiative/initiative-delivery.js";
import type { InitiativeRecipient } from "../initiative/initiative-audience.js";
import { localClock } from "../initiative/weekly-review-dispatch.js";
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import { questProgress } from "./quest-after-success.js";
import type { QuestPerson } from "./quest-repository.js";
import { dueQuestTouch, touchCaption, type QuestAvailability, type QuestFacts, type QuestStep } from "./quest-steps.js";
import type { QuestReplyMarkup } from "./quest-transport.js";

export const QUEST_TOUCH_FIRST_HOUR = 11;
export const QUEST_TOUCH_LAST_HOUR = 20;

export interface QuestTouchDependencies {
  availability(): QuestAvailability;
  recipients(now: Date): Promise<InitiativeRecipient[]>;
  personalTime(recipient: InitiativeRecipient, now: Date): Promise<string | null>;
  person(input: { familyId: string; now: Date; userId: string }): Promise<QuestPerson | null>;
  facts(person: QuestPerson): Promise<QuestFacts>;
  mark(person: QuestPerson, marks: readonly string[], now: Date): Promise<Set<string>>;
  claim(person: QuestPerson, localDate: string, day: number, now: Date): Promise<string | null>;
  keyboard(person: QuestPerson, step: QuestStep, now: Date): Promise<QuestReplyMarkup>;
  card(input: { caption: string; chatId: string; replyMarkup: QuestReplyMarkup; step: QuestStep }): Promise<string>;
  record(delivery: InitiativeDelivery): Promise<void>;
}

function log(code: string, familyId: string, error: unknown): void {
  console.error(JSON.stringify({ code, error: error instanceof Error ? error.message : String(error), familyId }));
}

export function createQuestTouchDispatcher(dependencies: QuestTouchDependencies) {
  return async function dispatchQuestTouches(now = new Date()): Promise<number> {
    let sent = 0;
    for (const recipient of await dependencies.recipients(now)) {
      try {
        const clock = localClock(recipient.settings.timezone, now);
        if (clock.hour < QUEST_TOUCH_FIRST_HOUR || clock.hour >= QUEST_TOUCH_LAST_HOUR) continue;
        if (!decideInitiative(recipient.settings, recipient.state, now).allowed) continue;
        if (await dependencies.personalTime(recipient, now) !== null) continue;
        const person = await dependencies.person({ familyId: recipient.familyId, now, userId: recipient.userId });
        if (person === null || !person.active) continue;
        const day = dueQuestTouch({
          joinedOn: localClock(recipient.settings.timezone, person.joinedAt).date, marks: person.marks, today: clock.date,
        });
        if (day === null) continue;
        const facts = await dependencies.facts(person);
        const { done, next, steps } = questProgress(person, facts, dependencies.availability());
        await dependencies.mark(person, done.filter((step) => !person.marks.has(step.id)).map((step) => step.id), now);
        // Everything done: the closing message belongs to the success itself, not to a reminder.
        if (next === null) continue;
        const deliveryRef = await dependencies.claim(person, clock.date, day, now);
        if (deliveryRef === null) continue;
        const caption = touchCaption(done.length, steps.length, next);
        let replyMarkup: QuestReplyMarkup;
        try {
          replyMarkup = await dependencies.keyboard(person, next, now);
        } catch (error) {
          log("AGENT_ONBOARDING_QUEST_FAILED", person.familyId, error);
          continue;
        }
        let messageId: string;
        try {
          messageId = await dependencies.card({ caption, chatId: person.telegramUserId, replyMarkup, step: next });
        } catch (error) {
          log(error instanceof MemoryReviewOwnerAlertTransportError ? "AGENT_ONBOARDING_QUEST_FAILED" : "AGENT_ONBOARDING_QUEST_AMBIGUOUS",
            person.familyId, error);
          continue;
        }
        sent += 1;
        console.info(JSON.stringify({ code: "AGENT_ONBOARDING_QUEST_TOUCH_SENT", day, familyId: person.familyId, step: next.id }));
        try {
          await dependencies.record({
            at: now, deliveryRef, familyId: person.familyId, messageId, sourceKind: "feature_tip",
            telegramUserId: person.telegramUserId, text: caption, userId: person.userId,
          });
        } catch (error) {
          log("AGENT_INITIATIVE_DELIVERY_RECORD_FAILED", person.familyId, error);
        }
      } catch (error) {
        log("AGENT_ONBOARDING_QUEST_FAILED", recipient.familyId, error);
      }
    }
    return sent;
  };
}
