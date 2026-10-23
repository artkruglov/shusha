/**
 * «Помоги начать» under the message about a task that has not moved: the press becomes a chat turn.
 *
 * Exports:
 * - `STALE_TASK_HELP_PREFIX`: how the turn's text starts; the prompt rule for it keys on this.
 * - `createStaleTaskTurn`, `staleTaskTurn`: the press as a private chat message, or null when it is not one.
 *
 * Every other task button changes the task in code. This one asks the model for one small first step
 * (docs/design/task-lists-v3.ru.md), so the press is turned into an ordinary message of the presser in
 * their private chat and goes the same way a typed message goes: the same authorization from Telegram
 * and PostgreSQL, the same family budget gate, the same session. The text is built here from the task as
 * the repository reads it under the presser's rights; nothing in it comes from the model or the update.
 * The button is spent on the first press, so a second tap does not start a second turn; the durable
 * ingress already never replays an update after an ambiguous crash.
 */
import {
  answerTelegramCallbackQuery, editTelegramMessageReplyMarkup, parseTelegramUpdate, type TelegramCallbackQuery, type TelegramUpdate,
} from "eve/channels/telegram";

import { withFamilyDatabaseContext } from "../database-context.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { familyBudgetRepository } from "../family-budget-repository.js";
import { sharedTaskRepository } from "../shared-task-repository.js";
import { authorizeTaskButtonPress, productionTaskButtonAuthorizer, type TaskButtonAccess, type TaskButtonPress } from "./task-button-authorization.js";
import { parseTaskButtonCallbackData, TASK_BUTTON_CALLBACK_PREFIX } from "./task-button-callback-data.js";
import { taskButtonRepository, type TaskButtonRow } from "./task-button-repository.js";

export const STALE_TASK_HELP_PREFIX = "Помоги начать дело";
const TELEGRAM_TIMEOUT_MS = 15_000;

export interface StaleTaskTurnDependencies {
  authorize(row: TaskButtonRow, press: TaskButtonPress): Promise<TaskButtonAccess>;
  find(id: string): Promise<TaskButtonRow | null>;
  /** The task's title as the presser may read it now. */
  title(auth: MemoryAuthorization, taskId: string): Promise<string>;
  /** Whether the family's model may answer now; without it the press stays a button and nothing is spent. */
  modelAvailable(familyId: string): Promise<boolean>;
  /** Spends the button and the rest of its message, so the question is answered once. */
  spend(row: TaskButtonRow, messageButtonIds: readonly string[]): Promise<void>;
  /** Takes the buttons off the message and stops the spinner; a failure here does not stop the turn. */
  settleMessage(query: TelegramCallbackQuery): Promise<void>;
  now(): Date;
}

function messageButtonIds(query: TelegramCallbackQuery): string[] {
  const message = query.raw.message as { reply_markup?: { inline_keyboard?: { callback_data?: string }[][] } } | undefined;
  return (message?.reply_markup?.inline_keyboard ?? []).flat()
    .map((button) => parseTaskButtonCallbackData(button.callback_data ?? ""))
    .filter((id): id is string => id !== null);
}

export function createStaleTaskTurn(dependencies: StaleTaskTurnDependencies) {
  return async function staleTaskTurn(query: TelegramCallbackQuery): Promise<TelegramUpdate | null> {
    if (!query.data?.startsWith(TASK_BUTTON_CALLBACK_PREFIX)) return null;
    const id = parseTaskButtonCallbackData(query.data);
    const chat = query.message?.chat;
    if (!id || !chat || chat.type !== "private") return null;
    const row = await dependencies.find(id);
    // Anything else, a spent button or a refused press is the button handler's to answer.
    if (!row || row.action !== "help_start" || row.settled || row.taskId === null) return null;
    const access = await dependencies.authorize(row, { chat: { id: chat.id, type: chat.type }, presser: { id: query.from.id, isBot: query.from.isBot } });
    if (!access.allowed) return null;
    // Past the budget the turn would be silent: the buttons stay, and the handler says it cannot help now.
    if (!await dependencies.modelAvailable(row.familyId)) return null;
    // A task closed or out of reach since the message: the handler answers the press, no turn starts.
    const title = await withFamilyDatabaseContext(row.familyId, () => dependencies.title(access.auth, row.taskId!)).catch(() => null);
    if (title === null) return null;
    await withFamilyDatabaseContext(row.familyId, () => dependencies.spend(row, messageButtonIds(query)));
    await dependencies.settleMessage(query).catch((error: unknown) => console.error(JSON.stringify({
      code: "AGENT_TASK_BUTTON_REDRAW_FAILED", error: error instanceof Error ? error.message : String(error),
    })));
    const raw = query.raw as { from?: unknown; message?: { chat?: unknown; message_id?: unknown } };
    const update = parseTelegramUpdate({
      message: {
        // Not typed by the person: downstream code keyed by message ids can tell (the id is the bot's own message).
        osinara_synthetic: "stale_help",
        chat: raw.message?.chat,
        date: Math.floor(dependencies.now().getTime() / 1000),
        from: raw.from,
        message_id: raw.message?.message_id,
        text: `${STALE_TASK_HELP_PREFIX} «${title.replace(/\s+/gu, " ").trim()}»`,
      },
      update_id: 0,
    });
    console.info(JSON.stringify({ code: "AGENT_STALE_TASK_HELP_TURN", taskId: row.taskId }));
    return update?.kind === "message" ? update : null;
  };
}

let production: ReturnType<typeof createStaleTaskTurn> | undefined;

export function staleTaskTurn(query: TelegramCallbackQuery): Promise<TelegramUpdate | null> {
  production ??= createStaleTaskTurn({
    authorize: (row, press) => authorizeTaskButtonPress(row, press, productionTaskButtonAuthorizer),
    find: (id) => taskButtonRepository.find(id, new Date()),
    now: () => new Date(),
    async settleMessage(query) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) return;
      const credentials = { botToken: token };
      const fetch: typeof globalThis.fetch = (request, init) =>
        globalThis.fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS) });
      await answerTelegramCallbackQuery({ callbackQueryId: query.id, credentials, fetch, text: "Думаю, с чего начать…" });
      if (query.message) {
        await editTelegramMessageReplyMarkup({
          chatId: query.message.chat.id, credentials, fetch, messageId: query.message.messageId, replyMarkup: { inline_keyboard: [] },
        });
      }
    },
    modelAvailable: (familyId) => familyBudgetRepository.modelAvailable({ familyId, now: new Date() }),
    async spend(row, ids) {
      await taskButtonRepository.removeForTask([...new Set([row.id, ...ids])], row.taskId!, new Date());
    },
    async title(auth, taskId) {
      const result = await sharedTaskRepository.execute(auth, { action: "get", id: taskId }, `stale-help:${taskId}`) as { task: { title: string } };
      return result.task.title;
    },
  });
  return production(query);
}
