/**
 * Первые секунды после «Старт»: карточки с тем, что можно сделать, и кнопки первых шагов.
 *
 * Exports:
 * - `ONBOARDING_CARDS`: имена карточек в `infra/public/app/img/onboarding/`, по порядку альбома.
 * - `onboardingCardUrls`: адреса карточек рядом с Mini App, или null без публичного адреса.
 * - `sendOnboardingCards`: альбом карточек; сбой не мешает приветствию.
 * - `firstStepsKeyboard`: клавиатура с готовыми фразами, которые уходят как обычное сообщение человека.
 *
 * Приветствие было одним длинным текстом без кнопок (разбор онбординга 23 октября 2026): польза не видна, пока
 * человек не прочитал всё. Карточки показывают четыре дела картинкой, а кнопка с фразой даёт настоящий результат
 * с подтверждением за одно касание. Альбом шлёт код, не модель.
 */
import type { TelegramHandle } from "eve/channels/telegram";

import { webAppUrl } from "./web-app/web-app-menu.js";

export const ONBOARDING_CARDS = ["card-1-voice", "card-2-family", "card-3-homework", "card-4-shopping"] as const;

type Environment = NodeJS.ProcessEnv;

export function onboardingCardUrls(environment: Environment = process.env): string[] | null {
  const app = webAppUrl(environment);
  if (app === null) return null;
  return ONBOARDING_CARDS.map((card) => new URL(`img/onboarding/${card}.jpg`, app).toString());
}

export async function sendOnboardingCards(telegram: Pick<TelegramHandle, "chatId" | "request">, environment: Environment = process.env): Promise<void> {
  const urls = onboardingCardUrls(environment);
  if (urls === null) return;
  try {
    const response = await telegram.request("sendMediaGroup", {
      chat_id: telegram.chatId,
      media: urls.map((media) => ({ media, type: "photo" })),
    });
    if (!response.ok) throw new Error("Telegram did not accept sendMediaGroup");
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_ONBOARDING_CARDS_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
  }
}

export function firstStepsKeyboard(phrases: readonly string[]) {
  return {
    input_field_placeholder: "Или напишите своё, текстом или голосом",
    keyboard: phrases.map((text) => [{ text }]),
    one_time_keyboard: true,
    resize_keyboard: true,
  };
}
