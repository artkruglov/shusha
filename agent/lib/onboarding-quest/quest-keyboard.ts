/**
 * Кнопки под карточкой шага знакомства (миграция 197).
 *
 * Экспорт:
 * - `questCardKeyboard`: «Попробовать» · «Позже» / «Хватит подсказок».
 *
 * Кнопки только для адресата в его личке, как под «фишкой»: строка несёт его id, нажатие снова проверяет права.
 */
import type { CallbackButton, OverviewReplyMarkup } from "../task-buttons/overview-keyboard.js";
import { taskButtonCallbackData } from "../task-buttons/task-button-callback-data.js";
import { taskButtonRepository } from "../task-buttons/task-button-repository.js";
import { QUEST_TEXT, type QuestStep } from "./quest-steps.js";

export async function questCardKeyboard(input: {
  familyId: string; now: Date; step: QuestStep; telegramUserId: string;
}): Promise<OverviewReplyMarkup<CallbackButton>> {
  const [tryId, laterId, offId] = await taskButtonRepository.create({
    chatId: input.telegramUserId, familyId: input.familyId, now: input.now, recipientTelegramId: input.telegramUserId,
    items: [{ action: "quest_try", tip: input.step.number }, { action: "quest_later" }, { action: "tips_off" }],
  });
  return {
    inline_keyboard: [
      [
        { callback_data: taskButtonCallbackData(tryId!), text: QUEST_TEXT.labels.try },
        { callback_data: taskButtonCallbackData(laterId!), text: QUEST_TEXT.labels.later },
      ],
      [{ callback_data: taskButtonCallbackData(offId!), text: QUEST_TEXT.labels.off }],
    ],
  };
}
