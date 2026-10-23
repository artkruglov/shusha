/**
 * Кнопки под сообщением о давнем деле: «Помоги начать» · «Через неделю» / «Снять» · «Оставить».
 *
 * Export:
 * - `staleTaskKeyboard`: строки кнопок для одного дела и одного человека (миграция 192).
 *
 * Кнопки только для адресата: в личном чате другого человека нет, но строка всё равно несёт его id,
 * как «Беру / Не могу» под просьбой.
 */
import { STALE_TASK_LABELS, staleTaskButtons, type StaleTask } from "../initiative/stale-task.js";
import type { OverviewReplyMarkup } from "./overview-keyboard.js";
import { taskButtonCallbackData } from "./task-button-callback-data.js";
import { taskButtonRepository } from "./task-button-repository.js";

export async function staleTaskKeyboard(input: {
  familyId: string;
  modelAvailable: boolean;
  now: Date;
  task: StaleTask;
  telegramUserId: string;
}): Promise<OverviewReplyMarkup> {
  const items = staleTaskButtons(input.task, input.modelAvailable);
  const ids = await taskButtonRepository.create({
    chatId: input.telegramUserId, familyId: input.familyId, items, now: input.now, recipientTelegramId: input.telegramUserId,
  });
  const buttons = items.map((item, index) => ({
    callback_data: taskButtonCallbackData(ids[index]!),
    text: STALE_TASK_LABELS[item.action as keyof typeof STALE_TASK_LABELS],
  }));
  // Два в ряд (стайлгайд §3.11); без «Помоги начать» первая строка «Через неделю · Снять».
  const rows: (typeof buttons)[] = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  return { inline_keyboard: rows };
}
