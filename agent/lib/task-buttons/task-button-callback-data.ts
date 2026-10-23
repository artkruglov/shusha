/**
 * Callback data of a task button under a bot message (migration 179).
 *
 * Exports:
 * - `TASK_BUTTON_CALLBACK_PREFIX`: the prefix the keyboards write and the callback handler reads.
 * - `taskButtonCallbackData`: the data of one action row.
 * - `parseTaskButtonCallbackData`: the action id of a press, or null for any other button.
 *
 * The button carries only the id of a `task_button_actions` row: Telegram allows 64 bytes and shows
 * the data to everyone who sees the message, so the task, version and action stay in the database.
 */
export const TASK_BUTTON_CALLBACK_PREFIX = "tb:";

const PATTERN = /^tb:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

export function taskButtonCallbackData(actionId: string): string {
  const data = `${TASK_BUTTON_CALLBACK_PREFIX}${actionId}`;
  if (!PATTERN.test(data)) throw new Error("AGENT_TASK_BUTTON_ID_INVALID: id кнопки дела не UUID");
  return data;
}

export function parseTaskButtonCallbackData(data: string | undefined): string | null {
  return data?.match(PATTERN)?.[1] ?? null;
}
