/**
 * A press on a task button: the task changes in code, without the model and without an Eve turn.
 *
 * Exports:
 * - `createTaskButtonCallbackHandler`: the press processor; dependencies injected.
 * - `TASK_BUTTON_TEXT`: what a press answers in words.
 * - Production wiring: `task-button-callback-production.ts` (`handleTaskButtonCallback`).
 *
 * The model wrote «считаю сделанным» without closing anything (docs/telegram-task-buttons-plan.ru.md).
 * Here the change goes through the same task repository a chat turn uses, under the presser's live
 * rights (`task-button-authorization.ts`) and inside their family's row-level scope. The operation key
 * is the button's own id, so a second tap, a Telegram retry or a replay after a crash is a replay of the
 * same operation, not a second change. Every failure is answered to the presser and logged, and the
 * update completes: a press that throws would stay unanswered.
 */
import { type TelegramCallbackQuery } from "eve/channels/telegram";

import { AppError } from "../app-error.js";
import { withFamilyDatabaseContext } from "../database-context.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { type TaskVisibility } from "../shared-task-visibility.js";
import { type TaskButtonAccess, type TaskButtonPress, type TaskButtonRefusal } from "./task-button-authorization.js";
import {
  parseTaskButtonCallbackData,
  TASK_BUTTON_CALLBACK_PREFIX,
  taskButtonCallbackData,
} from "./task-button-callback-data.js";
import { type DailyOverviewSetting } from "./digest-settings.js";
import { claimedMessageText, claimLine } from "./group-claim-text.js";
import { struckOverview } from "./overview-strike.js";
import { pressToGroup, type ToGroupDependencies } from "./receipt-to-group.js";
import { isRichBoardPress, redrawBoard, type BoardRedrawDependencies } from "./board-buttons.js";
import { type MyTasksDependencies } from "./my-tasks-press.js";
import { pressBoardButton, type BoardPressDependencies } from "./board-presses.js";
import { isCoachTouchAction, pressCoachTouch, type CoachTouchPressDependencies } from "./coach-touch-press.js";
import { isQuestAction, pressQuestCard, type QuestPressDependencies } from "./quest-press.js";
import {
  isStaleTaskAction,
  pressStaleTask,
  replaceButtonsWithLine,
  type StaleTaskPressDependencies,
} from "./stale-task-press.js";
import { isAnswer, outcomeHolds, reverseItem, successText, type TaskResult } from "./task-button-outcome.js";
import type { TelegramTextEntity } from "../memory-review/memory-review-owner-alert-transport.js";
import { messageKeyboard, resolvedKeyboard, type ButtonState, type InlineKeyboard } from "./task-button-keyboard.js";
import { taskButtonRepository, type TaskButtonItem, type TaskButtonRow } from "./task-button-repository.js";

const TELEGRAM_TIMEOUT_MS = 15_000;
/** Bot API: the text of `answerCallbackQuery` is 0-200 characters; a longer one is rejected. */
const CALLBACK_TEXT_MAX_CHARACTERS = 200;

const TEXT = {
  conflict: "Это дело уже изменили. Скажи «покажи дела», чтобы увидеть, как оно сейчас.",
  /** The same conflict for an answer: someone was faster, or the person already answered elsewhere. */
  conflictAnswer: { accept: "Ответ на эту просьбу уже сохранён.", claim: "Это дело уже взяли.", decline: "Ответ на эту просьбу уже сохранён." },
  expired: "Кнопка устарела. Скажи словами, что сделать с делом.",
  /** «Помоги начать» that did not become a turn: spent, the task changed, or the family's model limit is used up. */
  noHelp: "Сейчас помочь с первым шагом не получится. «Через неделю», «Снять» и «Оставить» работают.",
  failed: "Не получилось. Попробуй нажать ещё раз чуть позже.",
  refused: {
    foreign_chat: "Эта кнопка работает только в том чате, куда я её прислал.",
    not_for_you: "Эта кнопка для другого человека.",
    not_member: "Дела семьи доступны только её участникам.",
  } satisfies Record<TaskButtonRefusal, string>,
} as const;

export interface TaskButtonCallbackDependencies extends ToGroupDependencies {
  answer(input: { callbackQueryId: string; showAlert: boolean; text: string }): Promise<void>;
  authorize(row: TaskButtonRow, press: TaskButtonPress): Promise<TaskButtonAccess>;
  /** True once per press: a replayed update after a crash must not send «Все дела» again. */
  claimDispatch(row: TaskButtonRow, callbackQueryId: string): Promise<boolean>;
  /** Who holds the tasks of these spent «Беру» buttons now (`taskButtonRepository.claimed`). */
  claimed(ids: readonly string[]): Promise<Array<{ name: string; title: string }>>;
  createButtons(row: TaskButtonRow, items: readonly TaskButtonItem[]): Promise<string[]>;
  editKeyboard(input: { chatId: string; keyboard: InlineKeyboard; messageId: string }): Promise<void>;
  /** The message text and its keyboard in one edit: «… берёт» under the group overview, «✓ ~~дело~~» in the morning one. */
  editText(input: {
    chatId: string; entities?: readonly TelegramTextEntity[]; keyboard: InlineKeyboard; messageId: string; text: string;
  }): Promise<void>;
  execute(auth: MemoryAuthorization, input: { action: string; id: string; version: number }, operationKey: string): Promise<TaskResult>;
  find(id: string): Promise<TaskButtonRow | null>;
  markRemoved(row: TaskButtonRow): Promise<void>;
  /** «Беру» and «Не могу» of the same task in this chat go away with the answer. */
  markAnswered(row: TaskButtonRow): Promise<void>;
  markReplaced(row: TaskButtonRow, replacementId: string): Promise<void>;
  resolve(ids: readonly string[]): Promise<ReadonlyMap<string, ButtonState | null>>;
  /** «Все дела»: the presser's board in this chat, as «покажи дела» would show it. */
  showAllTasks(auth: MemoryAuthorization, chatId: string): Promise<void>;
  /** A press is an answer: the pause after unanswered messages must not count it as silence. */
  markInitiativeAnswered(userId: string): Promise<void>;
  /** «Сводка»: a new message with the presser's overview hour and switch (`digest-settings.ts`). */
  openDigestSettings(auth: MemoryAuthorization, chatId: string): Promise<void>;
  /** An hour or «Выключить» pressed: saves the presser's own setting and redraws that message. */
  changeDigest(auth: MemoryAuthorization, setting: DailyOverviewSetting, message: { chatId: string; messageId: string }): Promise<void>;
  /** «Сделать общим / личным»: the task as it now is; a copy may carry a new id (`shared-task-visibility.ts`). */
  changeVisibility(auth: MemoryAuthorization, input: { id: string; version: number; visibility: TaskVisibility }, operationKey: string):
    Promise<{ id: string; title: string; version: number }>;
  /** «Для семьи» / «Только мне»: the presser's default, once; false when this button was already spent. */
  setDefaultVisibility(auth: MemoryAuthorization, visibility: TaskVisibility, pressedId: string, buttonIds: readonly string[]): Promise<boolean>;
  /** «Через неделю», «Снять», «Оставить» under the message about a task that has not moved. */
  stale: StaleTaskPressDependencies;
  /** «Мои дела» under the family group overview, shown only to the presser. */
  myTasks: MyTasksDependencies;
  boardRedraw: BoardRedrawDependencies;
  completeProject: BoardPressDependencies["completeProject"];
  /** «Попробовать», «Не интересно», «Не присылать советы» and «Не писать вечером» (`coach-touch-press.ts`). */
  coachTouch: CoachTouchPressDependencies;
  /** «Попробовать» and «Позже» under a first-steps quest card (`quest-press.ts`). */
  quest: QuestPressDependencies;
}

/** Our own formatting in a message as Telegram returns it; links and mentions it detects again by itself. */
function isFormatting(entity: unknown): entity is TelegramTextEntity {
  const value = entity as { length?: unknown; offset?: unknown; type?: unknown } | null;
  return typeof value?.offset === "number" && typeof value.length === "number" &&
    (value.type === "bold" || value.type === "strikethrough");
}

function clipText(text: string): string {
  const points = Array.from(text);
  return points.length <= CALLBACK_TEXT_MAX_CHARACTERS
    ? text
    : `${points.slice(0, CALLBACK_TEXT_MAX_CHARACTERS - 1).join("")}…`;
}

/** The task button ids of the message a press came from, in the keyboard's order. */
function keyboardIds(query: TelegramCallbackQuery): string[] {
  return (messageKeyboard(query.raw) ?? []).flat().map((button) => parseTaskButtonCallbackData(button.callback_data))
    .filter((id): id is string => id !== null);
}

function pressOf(query: TelegramCallbackQuery): TaskButtonPress | null {
  const chat = query.message?.chat;
  if (!chat) return null;
  return { chat: { id: chat.id, type: chat.type }, presser: { id: query.from.id, isBot: query.from.isBot } };
}

export function createTaskButtonCallbackHandler(dependencies: TaskButtonCallbackDependencies) {
  async function reply(query: TelegramCallbackQuery, text: string, showAlert: boolean): Promise<void> {
    try {
      await dependencies.answer({ callbackQueryId: query.id, showAlert, text: clipText(text) });
    } catch (error) {
      // The task is already changed or refused; the spinner on the button is all that is lost.
      console.error(JSON.stringify({
        code: "AGENT_TASK_BUTTON_ANSWER_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /**
   * The keyboard is redrawn from what each of its buttons is now in the database, never from the copy
   * in this update: two quick presses each carry the keyboard as it was before either.
   */
  async function redraw(
    query: TelegramCallbackQuery, familyId: string, action?: TaskButtonRow["action"], pressed?: { id: string; title: string },
  ): Promise<void> {
    const keyboard = messageKeyboard(query.raw);
    const message = query.message;
    if (!keyboard || !message) return;
    try {
      const ids = keyboardIds(query);
      const states = await withFamilyDatabaseContext(familyId, () => dependencies.resolve(ids));
      const next = resolvedKeyboard(keyboard, states, parseTaskButtonCallbackData, taskButtonCallbackData);
      const edited = action === "claim"
        ? await claimedText(query, familyId, ids).then((text) => text === null ? null : { text })
        : action === "complete" || action === "reopen" ? struckText(query, ids, states, pressed) : null;
      if (edited !== null) {
        await dependencies.editText({ ...edited, chatId: message.chat.id, keyboard: next, messageId: message.messageId });
        return;
      }
      await dependencies.editKeyboard({ chatId: message.chat.id, keyboard: next, messageId: message.messageId });
    } catch (error) {
      // The change is committed; a stale button is refused or replayed on the next tap.
      console.error(JSON.stringify({
        code: "AGENT_TASK_BUTTON_REDRAW_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /** The morning overview with its closed lines struck, from what each «✓»/«↩» button is now. */
  function struckText(
    query: TelegramCallbackQuery, ids: readonly string[], states: ReadonlyMap<string, ButtonState | null>,
    pressed?: { id: string; title: string },
  ): { entities: TelegramTextEntity[]; text: string } | null {
    const message = query.raw.message as { entities?: unknown; text?: unknown } | undefined;
    if (typeof message?.text !== "string") return null;
    const entities = Array.isArray(message.entities) ? message.entities.filter(isFormatting) : [];
    // In the keyboard's order. A repeated task done just now has no button left (no «Вернуть»), and is done.
    const tasks = ids.flatMap((id) => {
      const state = states.get(id);
      if (state && state.title !== null && (state.action === "complete" || state.action === "reopen")) {
        return [{ closed: state.action === "reopen", title: state.title }];
      }
      return !state && pressed?.id === id ? [{ closed: true, title: pressed.title }] : [];
    });
    return struckOverview(message.text, entities, tasks);
  }

  /** The group overview with who took what, or null when the text on screen already says it all. */
  async function claimedText(query: TelegramCallbackQuery, familyId: string, ids: readonly string[]): Promise<string | null> {
    const message = query.raw.message as { text?: unknown } | undefined;
    if (typeof message?.text !== "string") return null;
    const taken = await withFamilyDatabaseContext(familyId, () => dependencies.claimed(ids));
    return claimedMessageText(message.text, taken.map((task) => claimLine(task.name, task.title)));
  }

  /**
   * One answer to a tip or a quest card: a text message gets the line in place of its buttons; a step card is a photo
   * without text to edit, so only its buttons go.
   */
  async function settleButtons(query: TelegramCallbackQuery, line: string): Promise<void> {
    const message = query.raw.message as { text?: unknown } | undefined;
    if (typeof message?.text === "string" || !query.message) return replaceButtonsWithLine(dependencies.editText, query, line);
    await dependencies.editKeyboard({ chatId: query.message.chat.id, keyboard: [], messageId: query.message.messageId })
      .catch((error: unknown) => console.error(JSON.stringify({
        code: "AGENT_TASK_BUTTON_REDRAW_FAILED", error: error instanceof Error ? error.message : String(error),
      })));
  }

  /** A board with «✓» in its text is read again whole (`board-buttons.ts`); a keyboard is redrawn from its rows. */
  async function redrawAfter(
    query: TelegramCallbackQuery, row: TaskButtonRow, auth: MemoryAuthorization | null, action?: TaskButtonRow["action"],
  ): Promise<void> {
    if (!isRichBoardPress(query)) return redraw(query, row.familyId, action);
    if (auth !== null) await withFamilyDatabaseContext(row.familyId, () => redrawBoard(dependencies.boardRedraw, auth, query, row));
  }

  return async function handleTaskButtonCallback(query: TelegramCallbackQuery): Promise<boolean> {
    if (!query.data?.startsWith(TASK_BUTTON_CALLBACK_PREFIX)) return false;
    const id = parseTaskButtonCallbackData(query.data);
    let row: TaskButtonRow | null = null;
    let pressAuth: MemoryAuthorization | null = null;
    try {
      row = id ? await dependencies.find(id) : null;
      const press = pressOf(query);
      if (!row || !press) {
        await reply(query, TEXT.expired, true);
        return true;
      }
      const access = await dependencies.authorize(row, press);
      if (!access.allowed) {
        console.info(JSON.stringify({ code: "AGENT_TASK_BUTTON_REFUSED", reason: access.reason }));
        await reply(query, TEXT.refused[access.reason], true);
        return true;
      }
      const { auth } = access;
      pressAuth = auth;
      const current = row;
      if (auth.userId !== null) {
        await dependencies.markInitiativeAnswered(auth.userId).catch((error: unknown) => console.error(JSON.stringify({
          code: "AGENT_TASK_BUTTON_ANSWER_MARK_FAILED", error: error instanceof Error ? error.message : String(error),
        })));
      }
      const inFamily = <T>(work: () => Promise<T>) => withFamilyDatabaseContext(current.familyId, work);
      const boardSaid = await pressBoardButton(dependencies, { auth, inFamily, press, query, row: current });
      if (boardSaid !== null) return reply(query, boardSaid.text, boardSaid.alert).then(() => true);
      if (current.action === "all_tasks" || current.action === "digest_settings") {
        // Claimed before sending: an ambiguous crash after Telegram took the message is not sent twice.
        if (await inFamily(() => dependencies.claimDispatch(current, query.id))) {
          await inFamily(() => current.action === "all_tasks"
            ? dependencies.showAllTasks(auth, current.chatId)
            : dependencies.openDigestSettings(auth, current.chatId));
        }
        await reply(query, "", false);
        return true;
      }
      if (current.action === "digest_hour" || current.action === "digest_off") {
        const setting: DailyOverviewSetting = current.action === "digest_hour"
          ? { enabled: true, hour: current.settingValue }
          : { enabled: false, hour: null };
        await inFamily(() => dependencies.changeDigest(auth, setting, { chatId: press.chat.id, messageId: query.message!.messageId }));
        await reply(query, setting.enabled ? `Сводка будет приходить в ${setting.hour}:00.` : "Утренняя сводка выключена.", false);
        return true;
      }
      if (current.action === "default_family" || current.action === "default_personal") {
        const visibility: TaskVisibility = current.action === "default_family" ? "family" : "personal";
        if (!await inFamily(() => dependencies.setDefaultVisibility(auth, visibility, current.id, keyboardIds(query)))) {
          await reply(query, TEXT.expired, true);
          return true;
        }
        await reply(query, visibility === "family"
          ? "Новые дела буду записывать для семьи. Личное — скажите «только мне»."
          : "Новые дела буду записывать только вам. Общее — скажите «для семьи».", false);
        await redraw(query, current.familyId);
        return true;
      }
      if (current.action === "to_group") {
        const said = await pressToGroup(dependencies, { auth, ids: keyboardIds(query), inFamily, presserId: press.presser.id, row: current });
        await reply(query, said.text, said.alert);
        if (!said.alert) await redraw(query, current.familyId);
        return true;
      }
      // «Помоги начать» becomes a turn before this handler (`stale-task-turn.ts`); here it is only a stale press.
      if (current.action === "help_start") return reply(query, TEXT.noHelp, true).then(() => true);
      if (isStaleTaskAction(current.action)) {
        const row = { ...current, action: current.action }, operationKey = `button:${current.id}:${press.presser.id}`;
        const line = await inFamily(() => pressStaleTask(dependencies.stale, { auth, now: new Date(), operationKey, row }));
        // One answer to the question: every button of the message goes, the line takes their place.
        await inFamily(() => dependencies.removeForTask(keyboardIds(query), current.taskId!));
        await reply(query, line, false);
        await replaceButtonsWithLine(dependencies.editText, query, line);
        return true;
      }
      if (isCoachTouchAction(current.action)) {
        const row = { ...current, action: current.action };
        const line = await inFamily(() => pressCoachTouch(dependencies.coachTouch, { auth, chatId: press.chat.id, now: new Date(), row }));
        await reply(query, line, false);
        await settleButtons(query, line);
        return true;
      }
      if (isQuestAction(current.action)) {
        const row = { ...current, action: current.action };
        const line = await inFamily(() => pressQuestCard(dependencies.quest, { auth, chatId: press.chat.id, now: new Date(), row }));
        await reply(query, line, false);
        await settleButtons(query, line);
        return true;
      }
      if (current.action === "share" || current.action === "unshare") {
        const visibility: TaskVisibility = current.action === "share" ? "family" : "personal";
        const changed = await inFamily(() => dependencies.changeVisibility(
          auth, { id: current.taskId!, version: current.taskVersion!, visibility }, `button:${current.id}:${press.presser.id}`));
        if (!current.settled) {
          const [reverseId] = await inFamily(() => dependencies.createButtons(current, [{
            action: visibility === "family" ? "unshare" : "share", task: { id: changed.id, version: changed.version },
          }]));
          await inFamily(() => dependencies.markReplaced(current, reverseId!));
        }
        // A shared record no longer goes into a group from here: its «В группу» buttons go too.
        if (visibility === "family") await inFamily(() => dependencies.removeForTask(keyboardIds(query), current.taskId!, "to_group"));
        await reply(query, visibility === "family" ? `Теперь видят все в семье: ${changed.title}` : `Теперь только у вас: ${changed.title}`, false);
        await redraw(query, current.familyId);
        return true;
      }
      const task = await inFamily(() => dependencies.execute(
        auth,
        { action: current.action, id: current.taskId!, version: current.taskVersion! },
        // A family group button is shared: the key includes the presser, or a second member pressing
        // the same «Беру» would hit the first member's operation and be refused instead of told.
        `button:${current.id}:${press.presser.id}`,
      ));
      if (task.replayed && !outcomeHolds(current.action, task)) {
        // An old button pressed again after its change was undone: say what the task is now.
        await inFamily(() => dependencies.markRemoved(current));
        await reply(query, TEXT.conflict, true);
        await redrawAfter(query, current, auth, current.action);
        return true;
      }
      // A replay after a crash may find the button not yet turned into its reverse: finish that too.
      if (!current.settled) {
        const reverse = reverseItem(current.action, task, current.taskId!);
        if (reverse) {
          const [reverseId] = await inFamily(() => dependencies.createButtons(current, [reverse]));
          await inFamily(() => dependencies.markReplaced(current, reverseId!));
        } else {
          await inFamily(() => dependencies.markRemoved(current));
        }
        if (isAnswer(current.action)) await inFamily(() => dependencies.markAnswered(current));
      }
      await reply(query, successText(current.action, task), false);
      if (isRichBoardPress(query)) await redrawAfter(query, current, auth);
      else await redraw(query, current.familyId, current.action, { id: current.id, title: task.title });
      console.info(JSON.stringify({
        action: current.action, code: "AGENT_TASK_BUTTON_APPLIED", replayed: task.replayed, taskId: current.taskId,
      }));
    } catch (error) {
      const code = error instanceof AppError ? error.code : error instanceof Error ? error.name : "unknown";
      console.error(JSON.stringify({ action: row?.action ?? null, code: "AGENT_TASK_BUTTON_FAILED", errorCode: code }));
      if (code === "AGENT_TASK_VERSION_CONFLICT" && row) {
        const stale = row;
        await withFamilyDatabaseContext(stale.familyId, async () => {
          await dependencies.markRemoved(stale);
          if (isAnswer(stale.action)) await dependencies.markAnswered(stale);
        }).catch(() => undefined);
        await reply(query, isAnswer(stale.action) ? TEXT.conflictAnswer[stale.action] : TEXT.conflict, true);
        await redrawAfter(query, stale, pressAuth, stale.action);
      } else {
        await reply(query, error instanceof AppError ? error.message : TEXT.failed, true);
      }
    }
    return true;
  };
}

export const TASK_BUTTON_TEXT = TEXT;
