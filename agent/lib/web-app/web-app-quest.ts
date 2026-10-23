/**
 * «Знакомство» в Mini App: кольцо на шапке «Сегодня» и лист шагов (`infra/public/app/quest.js`).
 *
 * Exports:
 * - `WebAppQuest`: сколько пройдено, сколько всего и шаги по порядку.
 * - `createWebAppQuest`, `webAppQuest`: прогресс, «Попробовать в чате» и «Скрыть».
 *
 * Правила квеста живут в `onboarding-quest/`: какие шаги доступны, что засчитано, кто ещё в знакомстве. Здесь
 * только показ. «Попробовать в чате» шлёт в личку ту же карточку шага с кнопками, что и касание дня, а «Скрыть»
 * убирает кольцо из приложения (метка `app_hidden`), не выключая подсказки в чате.
 */
import type { MemoryAuthorization } from "../memory-context.js";
import { questProgress } from "../onboarding-quest/quest-after-success.js";
import { questAvailability } from "../onboarding-quest/quest-availability.js";
import { questCardKeyboard } from "../onboarding-quest/quest-keyboard.js";
import { questRepository, type QuestPerson } from "../onboarding-quest/quest-repository.js";
import { touchCaption, type QuestAvailability, type QuestFacts } from "../onboarding-quest/quest-steps.js";
import { questTransport, type QuestTransport } from "../onboarding-quest/quest-transport.js";
import { webAppBadRequest } from "./web-app-api.js";

export interface WebAppQuest {
  readonly done: number;
  readonly total: number;
  readonly steps: readonly { number: number; title: string; done: boolean }[];
}

const HIDDEN = "app_hidden";

export interface WebAppQuestDependencies {
  availability(): QuestAvailability;
  person(input: { familyId: string; now: Date; userId: string }): Promise<QuestPerson | null>;
  facts(person: QuestPerson): Promise<QuestFacts>;
  mark(person: QuestPerson, marks: readonly string[], now: Date): Promise<Set<string>>;
  keyboard: typeof questCardKeyboard;
  card: QuestTransport["card"];
}

export function createWebAppQuest(dependencies: WebAppQuestDependencies) {
  async function open(auth: MemoryAuthorization, now: Date) {
    const person = await dependencies.person({ familyId: auth.familyId, now, userId: auth.userId! });
    if (person === null || !person.active) return null;
    return { person, progress: questProgress(person, await dependencies.facts(person), dependencies.availability()) };
  }

  return {
    /** Null when the person is past the quest or hid the ring: the hero then shows nothing. */
    async read(auth: MemoryAuthorization, now: Date): Promise<WebAppQuest | null> {
      const quest = await open(auth, now);
      if (quest === null || quest.person.marks.has(HIDDEN)) return null;
      const done = new Set(quest.progress.done.map((step) => step.id));
      return {
        done: done.size,
        steps: quest.progress.steps.map((step) => ({
          done: done.has(step.id), number: step.number, title: step.title.charAt(0).toUpperCase() + step.title.slice(1),
        })),
        total: quest.progress.steps.length,
      };
    },

    /** The step card goes to the person's private chat; only a step that is offered to them and still open. */
    async tryStep(auth: MemoryAuthorization, number: number, now: Date): Promise<{ ok: true }> {
      const quest = await open(auth, now);
      const step = quest?.progress.steps.find((candidate) => candidate.number === number);
      if (quest === null || step === undefined || quest.progress.done.some((done) => done.id === step.id)) webAppBadRequest();
      const replyMarkup = await dependencies.keyboard({
        familyId: quest.person.familyId, now, step, telegramUserId: quest.person.telegramUserId,
      });
      await dependencies.card({
        caption: touchCaption(quest.progress.done.length, quest.progress.steps.length, step),
        chatId: quest.person.telegramUserId, replyMarkup, step,
      });
      return { ok: true };
    },

    async hide(auth: MemoryAuthorization, now: Date): Promise<{ ok: true }> {
      const person = await dependencies.person({ familyId: auth.familyId, now, userId: auth.userId! });
      if (person !== null) await dependencies.mark(person, [HIDDEN], now);
      return { ok: true };
    },
  };
}

export const webAppQuest = createWebAppQuest({
  availability: questAvailability,
  card: (input) => questTransport.card(input),
  facts: (person) => questRepository.facts(person),
  keyboard: questCardKeyboard,
  mark: (person, marks, now) => questRepository.mark(person, marks, now),
  person: (input) => questRepository.person(input),
});
