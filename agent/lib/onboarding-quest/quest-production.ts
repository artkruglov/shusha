/**
 * Производственная сборка знакомства после успеха.
 *
 * Экспорт:
 * - `advanceQuestAfterSuccess`: проверка и отправка с настоящими репозиториями и транспортом; сбой только в лог.
 *
 * Зовут её канал после личного хода (`agent/channels/telegram.ts`, `turn.completed`) и нажатие «Беру»/«Сделано» в
 * семейном чате (`task-button-callback-production.ts`). Чтения идут в области семьи человека: семья взята из
 * проверенной сессии или живой авторизации нажатия, не из текста модели.
 */
import { withFamilyDatabaseContext } from "../database-context.js";
import { questAvailability } from "./quest-availability.js";
import { createQuestAfterSuccess } from "./quest-after-success.js";
import { questCardKeyboard } from "./quest-keyboard.js";
import { questRepository } from "./quest-repository.js";
import { questTransport } from "./quest-transport.js";

const advance = createQuestAfterSuccess({
  availability: questAvailability,
  card: (input) => questTransport.card(input),
  facts: (person) => questRepository.facts(person),
  keyboard: (person, step, now) => questCardKeyboard({
    familyId: person.familyId, now, step, telegramUserId: person.telegramUserId,
  }),
  mark: (person, marks, now) => questRepository.mark(person, marks, now),
  person: (input) => questRepository.person(input),
  text: (input) => questTransport.text(input),
});

export async function advanceQuestAfterSuccess(actor: { familyId: string; userId: string }): Promise<void> {
  try {
    await withFamilyDatabaseContext(actor.familyId, () => advance(actor));
  } catch (error) {
    // The answer is already delivered; a lost quest card must never fail the turn or the press.
    console.error(JSON.stringify({
      code: "AGENT_ONBOARDING_QUEST_FAILED", error: error instanceof Error ? error.message.slice(0, 160) : String(error),
      familyId: actor.familyId,
    }));
  }
}
