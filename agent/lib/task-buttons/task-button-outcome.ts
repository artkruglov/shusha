/**
 * What a pressed task button did, in words and in the next button: pure, no database and no Telegram.
 *
 * Exports:
 * - `TaskResult`: the task after a press, as the repository returns it.
 * - `successText`: the short answer under the finger.
 * - `outcomeHolds`: whether the task is what the button leads to (a replay of an undone change is not).
 * - `reverseItem`: the button that undoes this press, when there is one.
 * - `isAnswer`: «Беру», «Принять» and «Не могу» answer a request.
 */
import type { TaskButtonItem, TaskButtonRow } from "./task-button-repository.js";

export interface TaskResult {
  repeat: unknown;
  /** The repository recognised the button's operation key: this is the task now, not a new change. */
  replayed: boolean;
  status: string;
  title: string;
  version: number;
}

export function successText(action: TaskButtonRow["action"], task: TaskResult): string {
  switch (action) {
    case "complete": return task.repeat ? `✓ Отметил: ${task.title}. Следующий раз уже в списке.` : `✓ Закрыто: ${task.title}`;
    case "reopen": return `↩ Вернул: ${task.title}`;
    case "claim": return `Теперь это твоё: ${task.title}`;
    case "accept": return `Принято: ${task.title}`;
    case "decline": return `Передал автору, что ты не можешь: ${task.title}`;
    case "all_tasks": case "digest_settings": case "digest_hour": case "digest_off":
    case "cancel": return `Снято: ${task.title}`;
    case "share": case "unshare": case "default_family": case "default_personal": case "to_group":
    case "help_start": case "postpone_week": case "keep": case "my_tasks": case "project_complete":
    case "tip_try": case "tip_dismiss": case "tips_off": case "evening_off": case "quest_try": case "quest_later": return "";
  }
}

/** Whether the task is now what the button's action leads to; a replay of an undone action is not. */
export function outcomeHolds(action: TaskButtonRow["action"], task: TaskResult): boolean {
  switch (action) {
    case "complete": return task.status === "completed" || Boolean(task.repeat);
    case "reopen": return !["completed", "cancelled", "declined"].includes(task.status);
    case "claim": case "accept": return task.status === "accepted";
    case "decline": return task.status === "declined";
    case "cancel": return task.status === "cancelled";
    case "all_tasks": case "digest_settings": case "digest_hour": case "digest_off":
    case "share": case "unshare": case "default_family": case "default_personal": case "to_group":
    case "help_start": case "postpone_week": case "keep": case "my_tasks": case "project_complete":
    case "tip_try": case "tip_dismiss": case "tips_off": case "evening_off": case "quest_try": case "quest_later": return true;
  }
}

/** The reverse of what was just done, when there is one: an undo stays one tap away. */
export function reverseItem(action: TaskButtonRow["action"], task: TaskResult, id: string): TaskButtonItem | null {
  // A repeated task moves to its next date on completion, and reopen does not move it back.
  if (action === "complete" && task.status === "completed" && !task.repeat) return { action: "reopen", task: { id, version: task.version } };
  if (action === "reopen") return { action: "complete", task: { id, version: task.version } };
  return null;
}

export function isAnswer(action: TaskButtonRow["action"]): action is "accept" | "claim" | "decline" {
  return action === "accept" || action === "claim" || action === "decline";
}
