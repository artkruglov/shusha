/**
 * «↩ Вернуть» under the receipt of what a turn closed, «Сделать общим / личным» under what it wrote, the one-time
 * «Новые дела: Для семьи · Только мне», and «Открыть доску» in a private chat.
 *
 * Exports:
 * - `RECEIPT_UNDO_MAX`: how many tasks get a button; a turn that closed more gets none.
 * - `RECEIPT_BOARD_TEXT`: the label of the button that opens the Mini App board.
 * - `receiptUndoKeyboard`: the keyboard for the tasks a receipt may reopen or change who sees, and the board.
 * - `attachReceiptUndo`: puts the buttons under the delivered message; never throws.
 *
 * The receipt goes out through the durable final delivery, whose stored contract has no keyboard. The
 * buttons are added afterwards by editing that message: if the edit fails, the person keeps the receipt
 * without buttons and can still say «верни». Each button is for the person who closed the task only.
 * Telegram opens a Mini App from an inline button only in a private chat, so a group receipt has no board.
 * Who-sees buttons exist only in a private chat (onboarding v3): there a new task is personal or shared, and the
 * person changes it with one tap; a task asked of another adult stays shared and gets none.
 * A single new personal record also gets «В «группа»» for each ordinary group whose chat the person is in now
 * (`receipt-to-group.ts`, GRP-09).
 */
import { editTelegramMessageReplyMarkup } from "eve/channels/telegram";

import { AppError } from "../app-error.js";
import { withFamilyDatabaseContext } from "../database-context.js";
import type { TaskTurnCreated, TaskTurnUndo } from "../task-turn-receipt.js";
import { webAppUrl } from "../web-app/web-app-menu.js";
import { taskButtonCallbackData } from "./task-button-callback-data.js";
import { liveGroupsOf } from "./receipt-to-group.js";
import { groupButtonLabel, taskButtonLabel, visibilityButtonLabel, type InlineKeyboard } from "./task-button-keyboard.js";
import { taskButtonRepository, type TaskButtonItem } from "./task-button-repository.js";

/** Three rows still read as «undo this»; ten would turn the receipt into a menu. */
export const RECEIPT_UNDO_MAX = 3;

export const RECEIPT_BOARD_TEXT = "Открыть доску";
export const DEFAULT_FAMILY_TEXT = "Новые дела: для семьи";
export const DEFAULT_PERSONAL_TEXT = "Новые дела: только мне";

/** A group a personal record may go into, with the record it is for. */
export interface ReceiptGroupChoice {
  readonly group: { id: string; title: string };
  readonly task: TaskTurnCreated;
}

/** The buttons of a receipt in their order: undo, who sees each new task, its groups, the one-time default question. */
function receiptItems(
  undo: readonly TaskTurnUndo[], shareable: readonly TaskTurnCreated[], askDefault: boolean, groups: readonly ReceiptGroupChoice[],
): TaskButtonItem[] {
  return [
    ...undo.map((task) => ({ action: "reopen" as const, task: { id: task.id, version: task.version } })),
    ...shareable.map((task) => ({
      action: task.scope === "family" ? "unshare" as const : "share" as const, task: { id: task.id, version: task.version },
    })),
    ...groups.map(({ group, task }) => ({ action: "to_group" as const, groupId: group.id, task: { id: task.id, version: task.version } })),
    ...(askDefault ? [{ action: "default_family" as const }, { action: "default_personal" as const }] : []),
  ];
}

export function receiptUndoKeyboard(
  undo: readonly TaskTurnUndo[], ids: readonly string[], boardUrl: string | null = null,
  shareable: readonly TaskTurnCreated[] = [], askDefault = false, groups: readonly ReceiptGroupChoice[] = [],
): InlineKeyboard {
  // A receipt about one record names it once, in its text; the buttons then say only what they do.
  const titled = new Set([...undo.map((task) => task.id), ...shareable.map((task) => task.id), ...groups.map(({ task }) => task.id)]).size > 1;
  const rows: InlineKeyboard = undo.map((task, index) => [{
    callback_data: taskButtonCallbackData(ids[index]!),
    text: titled ? taskButtonLabel("↩", `Вернуть · ${task.title}`) : "↩ Вернуть",
  }]);
  shareable.forEach((task, index) => rows.push([{
    callback_data: taskButtonCallbackData(ids[undo.length + index]!),
    text: visibilityButtonLabel(task.scope === "family" ? "unshare" : "share", titled ? task.title : null),
  }]));
  groups.forEach(({ group, task }, index) => rows.push([{
    callback_data: taskButtonCallbackData(ids[undo.length + shareable.length + index]!),
    text: groupButtonLabel(group.title, titled ? task.title : null),
  }]));
  if (askDefault) {
    // Each its own row: two in a row cut «Новые дела: для се…» on a phone.
    const first = undo.length + shareable.length + groups.length;
    rows.push([{ callback_data: taskButtonCallbackData(ids[first]!), text: DEFAULT_FAMILY_TEXT }]);
    rows.push([{ callback_data: taskButtonCallbackData(ids[first + 1]!), text: DEFAULT_PERSONAL_TEXT }]);
  }
  return boardUrl === null ? rows : [...rows, [{ text: RECEIPT_BOARD_TEXT, web_app: { url: boardUrl } }]];
}

export interface ReceiptUndoDependencies {
  /** The Mini App's address, or null when it is not configured (`web-app-menu.ts`). */
  boardUrl(): string | null;
  createButtons(input: {
    chatId: string; familyId: string; items: readonly TaskButtonItem[]; recipientTelegramId: string;
  }): Promise<string[]>;
  editKeyboard(input: { chatId: string; keyboard: InlineKeyboard; messageId: string }): Promise<void>;
  /** Ordinary groups of the family whose chat the person is in now, if this record may go there (`liveGroupsOf`). */
  liveGroups(familyId: string, telegramUserId: string, taskId: string): Promise<Array<{ id: string; title: string }>>;
}

export async function attachReceiptUndo(
  input: {
    chatId: string;
    familyId: string;
    messageId: string | null;
    telegramUserId: string;
    undo: readonly TaskTurnUndo[];
    created?: readonly TaskTurnCreated[];
    askDefault?: boolean;
  },
  dependencies: ReceiptUndoDependencies = productionDependencies,
): Promise<void> {
  const created = input.created ?? [];
  if (input.messageId === null || (input.undo.length === 0 && created.length === 0)) return;
  // A private chat's id is the person's own Telegram id.
  const privateChat = input.chatId === input.telegramUserId;
  const boardUrl = privateChat ? dependencies.boardUrl() : null;
  // Past three closed tasks the undo buttons would turn the receipt into a menu; the board still fits.
  const undo = input.undo.length > RECEIPT_UNDO_MAX ? [] : input.undo;
  // The same limit for who-sees buttons; a task asked of another adult stays shared.
  const changeable = privateChat ? created.filter((task) => !task.askedOther) : [];
  const shareable = changeable.length > RECEIPT_UNDO_MAX ? [] : changeable;
  const askDefault = privateChat && (input.askDefault ?? false);
  const messageId = input.messageId;
  const create = (items: readonly TaskButtonItem[]) => items.length === 0 ? Promise.resolve([] as string[])
    : withFamilyDatabaseContext(input.familyId, () => dependencies.createButtons({
      chatId: input.chatId, familyId: input.familyId, items, recipientTelegramId: input.telegramUserId,
    }));
  let ids: string[];
  try {
    const items = receiptItems(undo, shareable, askDefault, []);
    if (items.length === 0 && boardUrl === null) return;
    ids = await create(items);
    await dependencies.editKeyboard({ chatId: input.chatId, keyboard: receiptUndoKeyboard(undo, ids, boardUrl, shareable, askDefault), messageId });
  } catch (error) {
    // The receipt is delivered; only the shortcut is missing.
    logFailure("AGENT_TASK_RECEIPT_UNDO_FAILED", error);
    return;
  }
  // One new personal record of its own may go into a group; several would turn the receipt into a menu. Asking
  // Telegram who is in which chat takes a moment, so these rows come in a second edit and never hold the first.
  const single = shareable.length === 1 && shareable[0]!.scope === "personal" ? shareable[0]! : null;
  if (single === null) return;
  try {
    const groups = (await withFamilyDatabaseContext(input.familyId,
      () => dependencies.liveGroups(input.familyId, input.telegramUserId, single.id))).map((group) => ({ group, task: single }));
    if (groups.length === 0) return;
    const groupIds = await create(receiptItems([], [], false, groups));
    const split = undo.length + shareable.length;
    await dependencies.editKeyboard({
      chatId: input.chatId,
      keyboard: receiptUndoKeyboard(undo, [...ids.slice(0, split), ...groupIds, ...ids.slice(split)], boardUrl, shareable, askDefault, groups),
      messageId,
    });
  } catch (error) {
    logFailure("AGENT_TASK_RECEIPT_GROUPS_FAILED", error);
  }
}

function logFailure(code: string, error: unknown): void {
  console.error(JSON.stringify({
    code, errorCode: error instanceof AppError ? error.code : error instanceof Error ? error.name : "unknown",
  }));
}

const productionDependencies: ReceiptUndoDependencies = {
  boardUrl: () => webAppUrl(),
  createButtons: (input) => taskButtonRepository.create({ ...input, now: new Date() }),
  liveGroups: (familyId, telegramUserId, taskId) => liveGroupsOf(familyId, telegramUserId, taskId),
  async editKeyboard(input) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) throw new AppError("AGENT_TELEGRAM_BOT_TOKEN_MISSING", "Не задан TELEGRAM_BOT_TOKEN для кнопок дел");
    const response = await editTelegramMessageReplyMarkup({
      chatId: input.chatId,
      credentials: { botToken },
      fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(15_000) }),
      messageId: input.messageId,
      replyMarkup: { inline_keyboard: input.keyboard },
    });
    if (!response.ok) {
      throw new AppError("AGENT_TASK_RECEIPT_UNDO_FAILED", `Telegram не принял кнопки под квитанцией (HTTP ${response.status})`);
    }
  },
};
