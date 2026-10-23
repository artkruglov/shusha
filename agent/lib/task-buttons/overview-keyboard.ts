/**
 * Buttons under the morning overview: «✓ дело» for each task it shows, «Все дела · N», «Сводка»
 * (its hour and switch, `digest-settings.ts`) and «Доска», which opens the Mini App when it is configured.
 *
 * Exports:
 * - `OverviewReplyMarkup`, `CallbackButton`, `WebAppButton`, `MorningReplyMarkup`: keyboards as the plain transport sends them.
 * - `overviewKeyboard`: creates the button rows and returns the keyboard.
 *
 * A button names its task: a row of identical «Сделано» makes the person guess which is which. Since the
 * team review of 21 October 2026 the buttons go two in a row, each cut to a short label (five full-width
 * rows made the overview the longest message of the morning), a repeated task keeps its 🔁, and «Время
 * сводки» says what that button opens. Each button is for the overview's recipient only, in their private chat.
 */
import type { OverviewTask } from "../initiative/daily-overview.js";
import { taskButtonCallbackData } from "./task-button-callback-data.js";
import { taskButtonRepository, type TaskButtonItem } from "./task-button-repository.js";

/** About what a half-width button shows on a phone before Telegram cuts it itself. */
const PAIRED_LABEL_MAX = 18;

/** A type alias, not an interface: the Bot API body takes it as JSON, which needs an index signature. */
export type OverviewReplyMarkup<Button = CallbackButton> = { inline_keyboard: Button[][] };
export type CallbackButton = { callback_data: string; text: string };
export type WebAppButton = { text: string; web_app: { url: string } };
/** The morning overview's keyboard: task buttons and, when configured, «Доска» opening the Mini App. */
export type MorningReplyMarkup = OverviewReplyMarkup<CallbackButton | WebAppButton>;

export async function overviewKeyboard(input: {
  familyId: string;
  now: Date;
  openCount: number;
  shown: readonly OverviewTask[];
  telegramUserId: string;
  /** The Mini App page (`web-app-menu.ts`); without it there is no «Доска» button. */
  webAppUrl?: string | null;
}): Promise<MorningReplyMarkup> {
  const closable = input.shown.filter((task): task is OverviewTask & { id: string; version: number } =>
    typeof task.id === "string" && typeof task.version === "number");
  const items: TaskButtonItem[] = [
    ...closable.map((task) => ({ action: "complete" as const, task: { id: task.id, version: task.version } })),
    { action: "all_tasks" },
    { action: "digest_settings" },
  ];
  const ids = await taskButtonRepository.create({
    chatId: input.telegramUserId,
    familyId: input.familyId,
    items,
    now: input.now,
    recipientTelegramId: input.telegramUserId,
  });
  const buttons = closable.map((task, index) => ({
    callback_data: taskButtonCallbackData(ids[index]!), text: shortLabel(task.repeat ? `✓ 🔁 ${task.title}` : `✓ ${task.title}`),
  }));
  return {
    inline_keyboard: [
      ...pairs(buttons),
      [{ callback_data: taskButtonCallbackData(ids.at(-2)!), text: `Все дела · ${input.openCount}` }],
      [
        { callback_data: taskButtonCallbackData(ids.at(-1)!), text: "Время сводки" },
        ...(input.webAppUrl ? [{ text: "Доска", web_app: { url: input.webAppUrl } }] : []),
      ],
    ],
  };
}

function pairs<T>(buttons: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  return rows;
}

/** Cut on code points, so an emoji in a title is never split. */
function shortLabel(text: string): string {
  const points = Array.from(text.replace(/\s+/gu, " ").trim());
  return points.length <= PAIRED_LABEL_MAX ? points.join("") : `${points.slice(0, PAIRED_LABEL_MAX - 1).join("")}…`;
}
