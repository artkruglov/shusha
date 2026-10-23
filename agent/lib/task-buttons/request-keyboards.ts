/**
 * Buttons that answer for a person: «Беру / Не могу» under a request and «Беру» under unowned tasks.
 *
 * Exports:
 * - `requestKeyboard`: one row `[Беру · дело] [Не могу]` per task proposed to the recipient.
 * - `unownedKeyboard`: one «Беру · дело» per unowned task in the family group overview.
 * - `groupOverviewKeyboard`: those «Беру» and «Мои дела», which shows the presser their own family tasks
 *   in a message only they see (`my-tasks-press.ts`).
 *
 * A request was answered only in words, and silence is not consent (`partner-alert.ts`). The buttons
 * give the same answer in one tap; the press goes through the task repository as `accept`, `decline`
 * or `claim`, where only the recipient may accept and the first claim wins. In the family group the
 * button is for any live member of the family (`task-button-authorization.ts`).
 */
import type { OverviewReplyMarkup } from "./overview-keyboard.js";
import { taskButtonCallbackData } from "./task-button-callback-data.js";
import { taskButtonLabel } from "./task-button-keyboard.js";
import { taskButtonRepository } from "./task-button-repository.js";

export interface ButtonTask {
  readonly id: string;
  readonly title: string;
  readonly version: number;
}

export async function requestKeyboard(input: {
  familyId: string;
  now: Date;
  tasks: readonly ButtonTask[];
  telegramUserId: string;
}): Promise<OverviewReplyMarkup | null> {
  if (input.tasks.length === 0) return null;
  const ids = await taskButtonRepository.create({
    chatId: input.telegramUserId,
    familyId: input.familyId,
    items: input.tasks.flatMap((task) => [
      { action: "accept" as const, task: { id: task.id, version: task.version } },
      { action: "decline" as const, task: { id: task.id, version: task.version } },
    ]),
    now: input.now,
    recipientTelegramId: input.telegramUserId,
  });
  return {
    inline_keyboard: input.tasks.map((task, index) => [
      { callback_data: taskButtonCallbackData(ids[index * 2]!), text: taskButtonLabel("Беру ·", task.title) },
      { callback_data: taskButtonCallbackData(ids[index * 2 + 1]!), text: "Не могу" },
    ]),
  };
}

export async function groupOverviewKeyboard(input: {
  chatId: string;
  familyId: string;
  now: Date;
  tasks: readonly ButtonTask[];
}): Promise<OverviewReplyMarkup> {
  const ids = await taskButtonRepository.create({
    chatId: input.chatId,
    familyId: input.familyId,
    items: [
      ...input.tasks.map((task) => ({ action: "claim" as const, task: { id: task.id, version: task.version } })),
      { action: "my_tasks" as const },
      { action: "all_tasks" as const },
    ],
    now: input.now,
    recipientTelegramId: null,
  });
  return {
    inline_keyboard: [
      ...input.tasks.map((task, index) => [
        { callback_data: taskButtonCallbackData(ids[index]!), text: taskButtonLabel("Беру ·", task.title) },
      ]),
      // «Все дела» here is the family board in a message only the presser sees (`my-tasks-press.ts`).
      [{ callback_data: taskButtonCallbackData(ids.at(-2)!), text: "Мои дела" },
        { callback_data: taskButtonCallbackData(ids.at(-1)!), text: "Все дела" }],
    ],
  };
}

export async function unownedKeyboard(input: {
  chatId: string;
  familyId: string;
  now: Date;
  tasks: readonly ButtonTask[];
}): Promise<OverviewReplyMarkup | null> {
  if (input.tasks.length === 0) return null;
  const ids = await taskButtonRepository.create({
    chatId: input.chatId,
    familyId: input.familyId,
    items: input.tasks.map((task) => ({ action: "claim" as const, task: { id: task.id, version: task.version } })),
    now: input.now,
    recipientTelegramId: null,
  });
  return {
    inline_keyboard: input.tasks.map((task, index) => [
      { callback_data: taskButtonCallbackData(ids[index]!), text: taskButtonLabel("Беру ·", task.title) },
    ]),
  };
}
