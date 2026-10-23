/**
 * Кнопки под «фишкой» и под итогом дня (миграция 195).
 *
 * Export:
 * - `featureTipKeyboard`: «Попробовать» · «Не интересно» / «Не присылать советы».
 * - `eveningReflectionKeyboard`: «Не писать вечером».
 *
 * Кнопки только для адресата, как под давним делом: строка несёт его id, а нажатие снова проверяет его права.
 */
import { FEATURE_TIP_LABELS, type FeatureTip } from "../coach-touches/feature-tips.js";
import type { OverviewReplyMarkup } from "./overview-keyboard.js";
import { taskButtonCallbackData } from "./task-button-callback-data.js";
import { taskButtonRepository } from "./task-button-repository.js";

export const EVENING_OFF_LABEL = "Не писать вечером";

export async function featureTipKeyboard(input: {
  familyId: string; now: Date; telegramUserId: string; tip: FeatureTip;
}): Promise<OverviewReplyMarkup> {
  const [tryId, dismissId, offId] = await taskButtonRepository.create({
    chatId: input.telegramUserId, familyId: input.familyId, now: input.now, recipientTelegramId: input.telegramUserId,
    items: [{ action: "tip_try", tip: input.tip.number }, { action: "tip_dismiss", tip: input.tip.number }, { action: "tips_off" }],
  });
  return {
    inline_keyboard: [
      [
        { callback_data: taskButtonCallbackData(tryId!), text: FEATURE_TIP_LABELS.tip_try },
        { callback_data: taskButtonCallbackData(dismissId!), text: FEATURE_TIP_LABELS.tip_dismiss },
      ],
      [{ callback_data: taskButtonCallbackData(offId!), text: FEATURE_TIP_LABELS.tips_off }],
    ],
  };
}

export async function eveningReflectionKeyboard(input: {
  familyId: string; now: Date; telegramUserId: string;
}): Promise<OverviewReplyMarkup> {
  const [offId] = await taskButtonRepository.create({
    chatId: input.telegramUserId, familyId: input.familyId, now: input.now, recipientTelegramId: input.telegramUserId,
    items: [{ action: "evening_off" }],
  });
  return { inline_keyboard: [[{ callback_data: taskButtonCallbackData(offId!), text: EVENING_OFF_LABEL }]] };
}
