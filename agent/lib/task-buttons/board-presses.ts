/**
 * Presses that answer with a board rather than a changed task: «Мои дела» and «Все дела» under the family group
 * overview, and «Завершить · проект» inside the private board.
 *
 * Exports:
 * - `BoardPressDependencies`: the ephemeral sends, the project repository, the board redraw and the button row.
 * - `pressBoardButton`: the answer under the finger, or null when the press is not one of these.
 *
 * Kept apart from `task-button-callback.ts`, which holds the press path itself.
 */
import type { TelegramCallbackQuery } from "eve/channels/telegram";

import type { MemoryAuthorization } from "../memory-context.js";
import { projectRepository } from "../projects/project-repository.js";
import { isRichBoardPress, redrawBoard, type BoardRedrawDependencies } from "./board-buttons.js";
import { pressFamilyBoard, pressMyTasks, type MyTasksDependencies } from "./my-tasks-press.js";
import type { TaskButtonPress } from "./task-button-authorization.js";
import type { TaskButtonRow } from "./task-button-repository.js";

export interface BoardPressDependencies {
  boardRedraw: BoardRedrawDependencies;
  myTasks: MyTasksDependencies;
  completeProject(auth: MemoryAuthorization, input: { id: string; version: number }, operationKey: string): Promise<{ title: string | null }>;
  markRemoved(row: TaskButtonRow): Promise<void>;
}

export const productionCompleteProject: BoardPressDependencies["completeProject"] = async (auth, input, operationKey) => {
  const result = await projectRepository.execute(auth, { action: "complete", ...input }, operationKey) as { project?: { title?: string } | null };
  return { title: result.project?.title ?? null };
};

export async function pressBoardButton(
  dependencies: BoardPressDependencies,
  input: {
    auth: MemoryAuthorization; inFamily: <T>(work: () => Promise<T>) => Promise<T>;
    press: TaskButtonPress; query: TelegramCallbackQuery; row: TaskButtonRow;
  },
): Promise<{ alert: boolean; text: string } | null> {
  const { auth, inFamily, press, query, row } = input;
  const ephemeral = { auth, callbackQueryId: query.id, chatId: press.chat.id, presserId: press.presser.id };
  if (row.action === "my_tasks") return inFamily(() => pressMyTasks(dependencies.myTasks, ephemeral));
  // In a group «Все дела» is the family board only the presser sees; in a private chat it is a new message (the callback).
  if (row.action === "all_tasks" && press.chat.type !== "private") return inFamily(() => pressFamilyBoard(dependencies.myTasks, ephemeral));
  if (row.action !== "project_complete") return null;
  // The repository refuses a project that still has open tasks; its message is the answer then.
  const project = await inFamily(() => dependencies.completeProject(
    auth, { id: row.taskId!, version: row.taskVersion! }, `button:${row.id}:${press.presser.id}`));
  await inFamily(() => dependencies.markRemoved(row));
  if (isRichBoardPress(query)) await inFamily(() => redrawBoard(dependencies.boardRedraw, auth, query, row));
  return { alert: false, text: project.title ? `Проект завершён: ${project.title}` : "Проект завершён." };
}
