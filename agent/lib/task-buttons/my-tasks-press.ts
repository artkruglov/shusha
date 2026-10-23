/**
 * «Мои дела» under the family group overview: the presser's family tasks in a message only they see.
 *
 * Exports:
 * - `MyTasksDependencies`, `myTasksDependencies`: the list and the ephemeral send; the production set.
 * - `formatMyTasks`: the text of that message.
 * - `pressMyTasks`: reads, sends, and says what to answer under the finger.
 * - `pressFamilyBoard`: «Все дела» under the group overview: the family's board, also only to the presser.
 *
 * Bot API 10.2–10.3 lets a bot answer one member of a group within 15 seconds of their button press so that
 * nobody else sees it (docs/design/task-lists-v3.ru.md). The press keeps the group's rights: a
 * `family_private` group gets only the `family` scope (CLAUDE.md), so the message holds the presser's
 * family tasks and never their personal ones, which stay in the private chat. If Telegram does not take
 * the ephemeral message, nothing goes to the group: the presser hears «open the private chat» instead.
 */
import { callTelegramApi } from "eve/channels/telegram";

import { AppError } from "../app-error.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { currentTimeRepository } from "../current-time-repository.js";
import { sharedTaskRepository } from "../shared-task-repository.js";
import { loadBoardProjects } from "../projects/project-board.js";
import { formatRichTaskBoard } from "../task-board-rich.js";
import { cleanTaskTitle, OPEN_TASK_STATUSES, type BoardTask } from "../task-board.js";

const ROWS = 10;
const TELEGRAM_TIMEOUT_MS = 15_000;
const PRIVATE_HINT = "Личные дела — в личке со мной.";

export interface MyTasksDependencies {
  list(auth: MemoryAuthorization): Promise<readonly BoardTask[]>;
  sendEphemeral(input: { callbackQueryId: string; chatId: string; receiverId: string; text: string }): Promise<void>;
  /** The whole family board in the group's scope, for «Все дела». */
  board(auth: MemoryAuthorization): Promise<string | null>;
  sendEphemeralRich(input: { callbackQueryId: string; chatId: string; markdown: string; receiverId: string }): Promise<void>;
}

export const myTasksDependencies: MyTasksDependencies = {
  async list(auth) {
    const result = await sharedTaskRepository.execute(auth, { action: "list", view: "mine" }, `my-tasks:${auth.telegramUserId}`);
    return (result as { tasks?: readonly BoardTask[] }).tasks ?? [];
  },
  sendEphemeral: (input) => ephemeral("sendMessage", input, { text: input.text }),
  async board(auth) {
    const result = await sharedTaskRepository.execute(auth, { action: "list" }, `family-board:${auth.telegramUserId}`);
    const timezone = await currentTimeRepository.findTurnTimezone(auth.userId, auth.familyId) ?? "UTC";
    const projects = await loadBoardProjects(auth);
    return formatRichTaskBoard({ heading: "Дела семьи", now: new Date(), tasks: (result as { tasks?: readonly BoardTask[] }).tasks ?? [], timezone,
      ...(projects ? { projects } : {}) });
  },
  sendEphemeralRich: (input) => ephemeral("sendRichMessage", input, { rich_message: { markdown: input.markdown } }),
};

async function ephemeral(
  method: "sendMessage" | "sendRichMessage", input: { callbackQueryId: string; chatId: string; receiverId: string }, content: Record<string, unknown>,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new AppError("AGENT_TELEGRAM_BOT_TOKEN_MISSING", "Не задан TELEGRAM_BOT_TOKEN для кнопок дел");
  const response = await callTelegramApi({
    body: {
      chat_id: input.chatId,
      ephemeral_message_parameters: { callback_query_id: input.callbackQueryId, receiver_user_id: Number(input.receiverId) },
      ...content,
    } as never,
    botToken: token,
    fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS) }),
    method,
  });
  if (!response.ok) {
    throw new AppError("AGENT_TASK_MY_TASKS_SEND_FAILED", `Telegram не принял сообщение только для участника (HTTP ${response.status})`);
  }
}

/** Plain text, one task a line, like the morning overview (стайлгайд §3.1); the count is honest. */
export function formatMyTasks(tasks: readonly BoardTask[]): string {
  const mine = tasks.filter((task) => task.kind === "task" && OPEN_TASK_STATUSES.has(task.status));
  if (mine.length === 0) return `Семейных дел на тебе нет.\n\n${PRIVATE_HINT}`;
  const shown = mine.slice(0, ROWS).map((task) => `• ${cleanTaskTitle(task.title, "plain")}`);
  const count = mine.length > shown.length ? `${mine.length} · показано ${shown.length}` : `${mine.length}`;
  return [`Твои семейные дела · ${count}`, ...shown, "", PRIVATE_HINT].join("\n");
}

/** «Все дела» in the group: the family board only the presser sees; personal tasks never come here. */
export async function pressFamilyBoard(
  dependencies: MyTasksDependencies,
  input: { auth: MemoryAuthorization; callbackQueryId: string; chatId: string; presserId: string },
): Promise<{ alert: boolean; text: string }> {
  const markdown = await dependencies.board(input.auth);
  if (markdown === null) return { alert: true, text: "Открытых семейных дел нет." };
  try {
    await dependencies.sendEphemeralRich({ callbackQueryId: input.callbackQueryId, chatId: input.chatId, markdown, receiverId: input.presserId });
    return { alert: false, text: "" };
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_TASK_MY_TASKS_SEND_FAILED", error: error instanceof Error ? error.message.slice(0, 160) : String(error),
    }));
    return { alert: true, text: "Здесь показать не получилось. Напиши мне в личку «покажи дела»." };
  }
}

/** The answer under the finger: empty when the message went, a hint to the private chat when it did not. */
export async function pressMyTasks(
  dependencies: MyTasksDependencies,
  input: { auth: MemoryAuthorization; callbackQueryId: string; chatId: string; presserId: string },
): Promise<{ alert: boolean; text: string }> {
  const text = formatMyTasks(await dependencies.list(input.auth));
  try {
    await dependencies.sendEphemeral({ callbackQueryId: input.callbackQueryId, chatId: input.chatId, receiverId: input.presserId, text });
    return { alert: false, text: "" };
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_TASK_MY_TASKS_SEND_FAILED", error: error instanceof Error ? error.message.slice(0, 160) : String(error),
    }));
    return { alert: true, text: "Здесь показать не получилось. Напиши мне в личку «покажи дела»." };
  }
}
