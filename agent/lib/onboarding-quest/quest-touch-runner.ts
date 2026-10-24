/**
 * Производственная сборка касаний знакомства.
 *
 * Экспорт:
 * - `dispatchQuestTouches`: диспетчер с настоящими репозиториями, флагами сервера и транспортом.
 *
 * Идёт в том же десятиминутном тике, что «фишка» (`agent/schedules/feature-tip.ts`), и тем же видом заявки: в один
 * местный день человек получает либо касание, либо совет. Фон работает в системной области, как у «фишки».
 * Касание начинает сам бот, поэтому чат, который Telegram уже назвал недоступным, пропускается без запроса.
 */
import { recordInitiativeDelivery } from "../initiative/initiative-delivery.js";
import { TelegramRecipientUnreachableError } from "../memory-review/memory-review-owner-alert-transport.js";
import { claimIfReachable, unreachableTelegramRecipient } from "../telegram-reachability/reachability-guard.js";
import { personalTimeRepository } from "../personal-time/personal-time-repository.js";
import { questAvailability } from "./quest-availability.js";
import { questCardKeyboard } from "./quest-keyboard.js";
import { questRepository } from "./quest-repository.js";
import { createQuestTouchDispatcher } from "./quest-touch-dispatch.js";
import { questTransport } from "./quest-transport.js";

export function dispatchQuestTouches(now = new Date()): Promise<number> {
  return createQuestTouchDispatcher({
    availability: questAvailability,
    async card(input) {
      const unreachable = await unreachableTelegramRecipient(input.chatId, "onboarding_quest");
      if (unreachable !== null) throw new TelegramRecipientUnreachableError(input.chatId, unreachable);
      return questTransport.card(input);
    },
    claim: (person, localDate, day, at) => claimIfReachable(person.telegramUserId, "initiative",
      () => questRepository.claimTouch(person, localDate, day, at)),
    facts: (person) => questRepository.facts(person),
    keyboard: (person, step, at) => questCardKeyboard({
      familyId: person.familyId, now: at, step, telegramUserId: person.telegramUserId,
    }),
    mark: (person, marks, at) => questRepository.mark(person, marks, at),
    person: (input) => questRepository.person(input),
    personalTime: (recipient, at) => personalTimeRepository.conflictFor(recipient.telegramUserId, recipient.familyId, at),
    recipients: (at) => questRepository.recipients(at),
    record: recordInitiativeDelivery,
  })(now);
}
