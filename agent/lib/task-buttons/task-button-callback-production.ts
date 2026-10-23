/**
 * The production wiring of task button presses: the bot token, Telegram calls and repositories behind
 * `createTaskButtonCallbackHandler` (`task-button-callback.ts`).
 *
 * Export:
 * - `handleTaskButtonCallback`: the production handler used by the durable ingress.
 *
 * Split from the handler on 21 October 2026 (code review): the press path and its wiring had grown past the
 * 500-line limit together; tests build the handler with their own dependencies and never load this file.
 */
import {
  answerTelegramCallbackQuery,
  callTelegramApi,
  editTelegramMessageReplyMarkup,
  type TelegramCallbackQuery,
} from "eve/channels/telegram";

import { AppError } from "../app-error.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { currentTimeRepository } from "../current-time-repository.js";
import { initiativeRepository } from "../initiative/initiative-repository.js";
import { dailyOverviewRepository } from "../initiative/daily-overview-repository.js";
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import { sharedTaskRepository } from "../shared-task-repository.js";
import { sharedTaskVisibility } from "../shared-task-visibility.js";
import { authorizeTaskButtonPress, productionTaskButtonAuthorizer } from "./task-button-authorization.js";
import { createTaskButtonCallbackHandler, TASK_BUTTON_TEXT } from "./task-button-callback.js";
import type { TaskResult } from "./task-button-outcome.js";
import { dailyOverviewSettings, digestSettingsKeyboard, digestSettingsText } from "./digest-settings.js";
import { toGroupDependencies } from "./receipt-to-group.js";
import { boardMarkdown, boardRedrawDependencies, sendBoardMessage } from "./board-buttons.js";
import { myTasksDependencies } from "./my-tasks-press.js";
import { productionCompleteProject } from "./board-presses.js";
import { coachTouchPressDependencies } from "./coach-touch-press.js";
import { questPressDependencies } from "./quest-press.js";
import { featureUseRepository } from "../feature-uses/feature-use-repository.js";
import { advanceQuestAfterSuccess } from "../onboarding-quest/quest-production.js";
import { staleTaskPressDependencies } from "./stale-task-press.js";
import { taskButtonRepository } from "./task-button-repository.js";


const TELEGRAM_TIMEOUT_MS = 15_000;
const TEXT = TASK_BUTTON_TEXT;

function botToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new AppError("AGENT_TELEGRAM_BOT_TOKEN_MISSING", "Не задан TELEGRAM_BOT_TOKEN для кнопок дел");
  return token;
}

const timedFetch: typeof fetch = (request, init) =>
  fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS) });

/**
 * «Беру» or «Сделано» pressed in the family group: the quest step «общее дело в чате» (`onboarding-quest/`). The press
 * itself is the trace (`feature_uses.group_task`), since its button row is gone in a week; then the presser may get the
 * next step card in their private chat. Bookkeeping never fails the press.
 */
async function recordGroupTask(auth: MemoryAuthorization, action: string): Promise<void> {
  if (auth.groupId === null || auth.userId === null || (action !== "claim" && action !== "complete")) return;
  const actor = { familyId: auth.familyId, userId: auth.userId };
  try {
    await featureUseRepository.record({ ...actor, features: ["group_task"], now: new Date() });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_FEATURE_USE_RECORD_FAILED", error: error instanceof Error ? error.message : String(error),
    }));
    return;
  }
  // The press is answered first; the card goes to the private chat on its own, its failure only logged.
  void advanceQuestAfterSuccess(actor);
}

let productionHandler: ReturnType<typeof createTaskButtonCallbackHandler> | undefined;

export function handleTaskButtonCallback(query: TelegramCallbackQuery): Promise<boolean> {
  productionHandler ??= createTaskButtonCallbackHandler({
    stale: staleTaskPressDependencies,
    myTasks: myTasksDependencies,
    boardRedraw: boardRedrawDependencies,
    completeProject: productionCompleteProject,
    coachTouch: coachTouchPressDependencies,
    quest: questPressDependencies,
    async answer(input) {
      const response = await answerTelegramCallbackQuery({
        callbackQueryId: input.callbackQueryId,
        credentials: { botToken: botToken() },
        fetch: timedFetch,
        showAlert: input.showAlert,
        text: input.text,
      });
      if (!response.ok) {
        throw new AppError("AGENT_TASK_BUTTON_ANSWER_FAILED", `Telegram не принял ответ на кнопку (HTTP ${response.status})`);
      }
    },
    authorize: (row, press) => authorizeTaskButtonPress(row, press, productionTaskButtonAuthorizer),
    claimDispatch: (row, callbackQueryId) => taskButtonRepository.claimDispatch(row.id, callbackQueryId),
    claimed: (ids) => taskButtonRepository.claimed(ids),
    createButtons: (row, items) => taskButtonRepository.create({
      chatId: row.chatId,
      familyId: row.familyId,
      items,
      now: new Date(),
      recipientTelegramId: row.recipientTelegramId,
    }),
    async editKeyboard(input) {
      const response = await editTelegramMessageReplyMarkup({
        chatId: input.chatId,
        credentials: { botToken: botToken() },
        fetch: timedFetch,
        messageId: input.messageId,
        replyMarkup: { inline_keyboard: input.keyboard },
      });
      if (!response.ok) {
        throw new AppError("AGENT_TASK_BUTTON_REDRAW_FAILED", `Telegram не принял правку кнопок (HTTP ${response.status})`);
      }
    },
    async editText(input) {
      const response = await callTelegramApi({
        body: {
          chat_id: input.chatId,
          ...(input.entities && input.entities.length > 0 ? { entities: input.entities.map((entity) => ({ ...entity })) } : {}),
          message_id: Number(input.messageId),
          // Task buttons carry a label and callback data (`task-button-keyboard.ts`); «Доска» opens the Mini App.
          reply_markup: { inline_keyboard: input.keyboard.map((row) => row.map((button) => {
            const webApp = button.web_app as { url?: unknown } | undefined;
            return {
              text: button.text, ...(button.callback_data === undefined ? {} : { callback_data: button.callback_data }),
              ...(typeof webApp?.url === "string" ? { web_app: { url: webApp.url } } : {}),
            };
          })) },
          text: input.text,
        },
        botToken: botToken(),
        fetch: timedFetch,
        method: "editMessageText",
      });
      if (!response.ok) {
        throw new AppError("AGENT_TASK_BUTTON_REDRAW_FAILED", `Telegram не принял правку сообщения (HTTP ${response.status})`);
      }
    },
    ...toGroupDependencies,
    async changeVisibility(auth, input, operationKey) {
      const { task } = await sharedTaskVisibility.change(auth, input, operationKey);
      return { id: task.id, title: task.title, version: task.version };
    },
    async setDefaultVisibility(auth, visibility, pressedId, buttonIds) {
      if (auth.userId === null) throw new AppError("AGENT_ACCESS_DENIED", "Нет доступа");
      return taskButtonRepository.answerDefaultChoice({
        familyId: auth.familyId, ids: buttonIds, now: new Date(), pressedId, userId: auth.userId, visibility,
      });
    },
    async execute(auth, input, operationKey) {
      const result = await sharedTaskRepository.execute(auth, input as never, operationKey) as {
        replayed?: boolean; task?: Omit<TaskResult, "replayed">;
      };
      if (!result.task) throw new AppError("AGENT_TASK_BUTTON_RESULT_MISSING", "Дело не вернулось после изменения");
      if (result.replayed !== true) await recordGroupTask(auth, input.action);
      return { ...result.task, replayed: result.replayed === true };
    },
    find: (id) => taskButtonRepository.find(id, new Date()),
    markInitiativeAnswered: (userId) => initiativeRepository.markAnswered(userId, new Date()),
    markAnswered: (row) => taskButtonRepository.markAnswersRemoved({ chatId: row.chatId, id: row.id, taskId: row.taskId! }, new Date()),
    markRemoved: (row) => taskButtonRepository.markRemoved(row.id, new Date()),
    markReplaced: (row, replacementId) => taskButtonRepository.markReplaced(row.id, replacementId),
    resolve: (ids) => taskButtonRepository.resolve(ids),
    async openDigestSettings(auth, chatId) {
      if (auth.userId === null) throw new AppError("AGENT_TASK_BUTTON_FAILED", TEXT.failed);
      const setting = await dailyOverviewSettings.read(auth.userId);
      const replyMarkup = await digestSettingsKeyboard({ chatId, familyId: auth.familyId, now: new Date(), setting });
      await memoryReviewOwnerAlertTransport.send({ chatId, replyMarkup, text: digestSettingsText(setting) });
    },
    async changeDigest(auth, setting, message) {
      if (auth.userId === null) throw new AppError("AGENT_TASK_BUTTON_FAILED", TEXT.failed);
      await dailyOverviewSettings.write({ familyId: auth.familyId, setting, userId: auth.userId });
      const saved = await dailyOverviewSettings.read(auth.userId);
      const replyMarkup = await digestSettingsKeyboard({ chatId: message.chatId, familyId: auth.familyId, now: new Date(), setting: saved });
      // The setting is saved; a failed redraw only leaves the old hour on screen until the next press.
      try {
        const response = await callTelegramApi({
          body: { chat_id: message.chatId, message_id: Number(message.messageId), reply_markup: replyMarkup, text: digestSettingsText(saved) },
          botToken: botToken(),
          fetch: timedFetch,
          method: "editMessageText",
        });
        if (!response.ok) console.error(JSON.stringify({ code: "AGENT_TASK_BUTTON_REDRAW_FAILED", status: response.status }));
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_TASK_BUTTON_REDRAW_FAILED", error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    async showAllTasks(auth, chatId) {
      // The whole board, read the way the morning overview reads it: by the presser's own identity.
      if (auth.userId === null || auth.telegramUserId === null) throw new AppError("AGENT_TASK_BUTTON_FAILED", TEXT.failed);
      const timezone = await currentTimeRepository.findTurnTimezone(auth.userId, auth.familyId) ?? "UTC";
      const overview = await dailyOverviewRepository.overview({
        familyId: auth.familyId, settings: { timezone }, telegramUserId: auth.telegramUserId, userId: auth.userId,
      });
      // The same board «покажи дела» sends, with «✓» in its text (ревью 21 октября 2026: был простой текст).
      const board = await boardMarkdown({ auth, now: overview.now, query: { source: "overview" }, tasks: overview.tasks, timezone,
        waiting: overview.waiting, ...(overview.offered ? { offered: overview.offered } : {}),
        ...(overview.projects ? { projects: overview.projects } : {}) });
      if (board === null) await memoryReviewOwnerAlertTransport.send({ chatId, text: "Открытых дел нет." });
      else await sendBoardMessage(chatId, board);
    },
  });
  return productionHandler(query);
}
