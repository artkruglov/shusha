/**
 * The task board as its own message, with «✓» inside the text, and its redraw after a press.
 *
 * Exports:
 * - `boardMarkdown`: the board for one chat; in a private chat it carries «✓» for today's and overdue tasks,
 *   «Беру» for the free ones, «Завершить» for a project whose tasks are all done, «Разобрать» and «Открыть доску»
 *   for the Mini App; in a group, no buttons.
 * - `richBoardButtonIds`: the task button ids inside a rich message, as Telegram returns it in a press.
 * - `isRichBoardPress`: whether a press came from such a message.
 * - `BoardRedrawDependencies`, `boardRedrawDependencies`, `redrawBoard`: the same board read again after a press.
 * - `sendBoardMessage`: the board as a new message from code (the overview's «Все дела»).
 *
 * Checked on a live client on 21 October 2026: a callback button inside a rich message, even inside a folded
 * project, reaches the bot. After a press the board is read again from the repository under the presser's rights
 * and the message is edited with it: what this board closed stays on top, struck, with «↩ Вернуть»
 * (style guide §3.4–3.5); nothing is redrawn from the copy in the update.
 */
import { callTelegramApi, type TelegramCallbackQuery } from "eve/channels/telegram";

import { AppError } from "../app-error.js";
import { currentTimeRepository } from "../current-time-repository.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { loadBoardProjects } from "../projects/project-board.js";
import { sharedTaskRepository } from "../shared-task-repository.js";
import { formatRichTaskBoard, type BoardButtons } from "../task-board-rich.js";
import { dailyOverviewRepository } from "../initiative/daily-overview-repository.js";
import { taskBoardSections, type BoardProject, type BoardTask } from "../task-board.js";
import { webAppUrl } from "../web-app/web-app-menu.js";
import { parseTaskButtonCallbackData, taskButtonCallbackData } from "./task-button-callback-data.js";
import { taskButtonRepository, type BoardQuery, type TaskButtonRow } from "./task-button-repository.js";

type ListedTask = BoardTask & { readonly id?: string; readonly version?: number };
const TELEGRAM_TIMEOUT_MS = 15_000;

export async function boardMarkdown(input: {
  auth: MemoryAuthorization;
  closed?: BoardButtons["closed"];
  now: Date;
  projects?: readonly BoardProject[];
  /** What this board shows; its buttons keep it, so a press redraws the same board (migration 194). */
  query: BoardQuery;
  tasks: readonly ListedTask[];
  timezone: string;
  waiting?: readonly BoardTask[];
}): Promise<string | null> {
  const { auth } = input;
  const chatId = auth.groupId === null && auth.telegramUserId !== null ? auth.telegramUserId : null;
  const content = { now: input.now, tasks: input.tasks, timezone: input.timezone,
    ...(input.projects ? { projects: input.projects } : {}), ...(input.waiting ? { waiting: input.waiting } : {}) };
  if (chatId === null) return formatRichTaskBoard(content);
  const { sections } = taskBoardSections({ now: input.now, style: "rich", tasks: input.tasks, timezone: input.timezone,
    ...(input.projects ? { projects: input.projects } : {}) });
  const rowsOf = (kinds: readonly string[]) => sections.filter((section) => kinds.includes(section.kind))
    .flatMap((section) => section.rows.slice(0, section.limit));
  const versioned = (task: ListedTask | null): task is ListedTask & { id: string; version: number } =>
    task !== null && typeof task.id === "string" && typeof task.version === "number";
  const closable = rowsOf(["today", "overdue"]).map((row) => row.task as ListedTask | null)
    .filter((task): task is ListedTask & { id: string; version: number } => versioned(task) && task.status === "accepted");
  const free = rowsOf(["unowned"]).map((row) => row.task as ListedTask | null)
    .filter((task): task is ListedTask & { id: string; version: number } => versioned(task) && task.status === "open");
  const finished = rowsOf(["finished"]).flatMap((row) => row.project && typeof row.project.version === "number"
    ? [{ id: row.project.id, version: row.project.version }] : []);
  const ids = await taskButtonRepository.create({
    chatId, familyId: auth.familyId, now: input.now, recipientTelegramId: chatId,
    items: [
      ...closable.map((task) => ({ action: "complete" as const, task: { id: task.id, version: task.version } })),
      ...free.map((task) => ({ action: "claim" as const, task: { id: task.id, version: task.version } })),
      ...finished.map((project) => ({ action: "project_complete" as const, task: project })),
    ].map((item) => ({ ...item, boardQuery: input.query })),
  });
  const data = (index: number) => taskButtonCallbackData(ids[index]!);
  const app = webAppUrl();
  const buttons: BoardButtons = {
    complete: new Map(closable.map((task, index) => [task.id, data(index)])),
    claim: new Map(free.map((task, index) => [task.id, data(closable.length + index)])),
    finish: new Map(finished.map((project, index) => [project.id, data(closable.length + free.length + index)])),
    ...(app ? { open: app, review: `${app}#review` } : {}),
    ...(input.closed ? { closed: input.closed } : {}),
  };
  return formatRichTaskBoard({ ...content, buttons });
}

export async function sendBoardMessage(chatId: string, markdown: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new AppError("AGENT_TELEGRAM_BOT_TOKEN_MISSING", "Не задан TELEGRAM_BOT_TOKEN для кнопок дел");
  const response = await callTelegramApi({
    body: { chat_id: chatId, rich_message: { markdown } },
    botToken: token,
    fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS) }),
    method: "sendRichMessage",
  });
  if (!response.ok) throw new AppError("AGENT_TASK_BOARD_DELIVERY_FAILED", `Telegram не принял доску (HTTP ${response.status})`);
}

/** Every `callback_data` anywhere in the message, in order; only task buttons are kept. */
export function richBoardButtonIds(raw: Record<string, unknown>): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "callback_data" && typeof inner === "string") found.push(inner);
        else walk(inner);
      }
    }
  };
  walk((raw.message as { rich_message?: unknown } | undefined)?.rich_message);
  return found.map((data) => parseTaskButtonCallbackData(data)).filter((id): id is string => id !== null);
}

export function isRichBoardPress(query: TelegramCallbackQuery): boolean {
  return Boolean((query.raw.message as { rich_message?: unknown } | undefined)?.rich_message);
}

export interface BoardRedrawDependencies {
  read(auth: MemoryAuthorization, query: BoardQuery): Promise<{
    projects?: readonly BoardProject[]; tasks: readonly ListedTask[]; timezone: string; waiting?: readonly BoardTask[];
  }>;
  resolve(ids: readonly string[]): Promise<ReadonlyMap<string, { action: string; id: string; status?: string | null; title: string | null } | null>>;
  /** The buttons the redrawn board no longer shows: settled, so the table does not keep them for a week. */
  retire(ids: readonly string[]): Promise<void>;
  edit(input: { chatId: string; markdown: string; messageId: string }): Promise<void>;
  board(input: Parameters<typeof boardMarkdown>[0]): Promise<string | null>;
  now(): Date;
}

export const boardRedrawDependencies: BoardRedrawDependencies = {
  async read(auth, query) {
    const timezone = await currentTimeRepository.findTurnTimezone(auth.userId, auth.familyId) ?? "UTC";
    if (query.source === "overview" && auth.userId !== null && auth.telegramUserId !== null) {
      // «Все дела» from the morning overview: read the way the overview reads it, by the person's own identity.
      const overview = await dailyOverviewRepository.overview({
        familyId: auth.familyId, settings: { timezone }, telegramUserId: auth.telegramUserId, userId: auth.userId,
      });
      return { tasks: overview.tasks, timezone, waiting: overview.waiting, ...(overview.projects ? { projects: overview.projects } : {}) };
    }
    const filters = query.source === "list" ? query.filters : {};
    const result = await sharedTaskRepository.execute(auth, { action: "list", ...filters } as never, "board-redraw") as { tasks?: readonly ListedTask[] };
    const projects = await loadBoardProjects(auth);
    return { tasks: result.tasks ?? [], timezone, ...(projects ? { projects } : {}) };
  },
  resolve: (ids) => taskButtonRepository.resolve(ids),
  retire: (ids) => taskButtonRepository.retire(ids, new Date()),
  async edit(input) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new AppError("AGENT_TELEGRAM_BOT_TOKEN_MISSING", "Не задан TELEGRAM_BOT_TOKEN для кнопок дел");
    const response = await callTelegramApi({
      body: { chat_id: input.chatId, message_id: Number(input.messageId), rich_message: { markdown: input.markdown } },
      botToken: token,
      fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS) }),
      method: "editMessageText",
    });
    if (!response.ok) throw new AppError("AGENT_TASK_BUTTON_REDRAW_FAILED", `Telegram не принял правку доски (HTTP ${response.status})`);
  },
  board: boardMarkdown,
  now: () => new Date(),
};

/** The board read again, with what its buttons closed on top; a failure leaves the old board and only logs. */
export async function redrawBoard(
  dependencies: BoardRedrawDependencies, auth: MemoryAuthorization, query: TelegramCallbackQuery, row: TaskButtonRow,
): Promise<void> {
  const message = query.message;
  if (!message) return;
  try {
    const ids = richBoardButtonIds(query.raw);
    const states = await dependencies.resolve(ids);
    const closed = new Map<string, { title: string; undo: string | null }>();
    for (const state of states.values()) {
      // Still closed: a task reopened in the chat since is open again and shows below, not struck on top.
      if (state?.action === "reopen" && state.title !== null && state.status === "completed") {
        closed.set(state.id, { title: state.title, undo: taskButtonCallbackData(state.id) });
      }
    }
    // The board the pressed button was drawn in; an older button without one redraws the whole open list.
    const boardQuery = row.boardQuery ?? { filters: {}, source: "list" as const };
    const { projects, tasks, timezone, waiting } = await dependencies.read(auth, boardQuery);
    const markdown = await dependencies.board({
      auth, closed: [...closed.values()], now: dependencies.now(), query: boardQuery, tasks, timezone,
      ...(projects ? { projects } : {}), ...(waiting ? { waiting } : {}),
    });
    if (markdown === null) return;
    await dependencies.edit({ chatId: message.chat.id, markdown, messageId: message.messageId });
    await dependencies.retire(ids.filter((id) => !closed.has(states.get(id)?.id ?? "")));
  } catch (error) {
    console.error(JSON.stringify({ code: "AGENT_TASK_BUTTON_REDRAW_FAILED", error: error instanceof Error ? error.message : String(error) }));
  }
}
