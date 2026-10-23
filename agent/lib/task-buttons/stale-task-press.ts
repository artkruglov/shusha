/**
 * A press under the message about a task that has not moved: «Через неделю», «Снять», «Оставить».
 *
 * Exports:
 * - `STALE_TASK_ACTIONS`, `isStaleTaskAction`: the actions this module answers.
 * - `StaleTaskPressDependencies`, `staleTaskPressDependencies`: what a press needs; the production set.
 * - `pressStaleTask`, `answerStaleTask`: do the change and say the line; the second without a button row.
 * - `replaceButtonsWithLine`: puts that line under the message text and takes every button away.
 *
 * The task changes through the same repository a chat turn uses, under the presser's live rights and the
 * button's version: a task changed since the message is refused as a conflict by the caller. Every answer
 * replaces all buttons of the message with one line, so the question is answered once
 * (docs/design/task-lists-v3.ru.md). «Помоги начать» is not here: it starts a turn (`stale-task-turn.ts`).
 */
import type { TelegramCallbackQuery } from "eve/channels/telegram";

import { currentTimeRepository } from "../current-time-repository.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { overviewRestRepository } from "../initiative/overview-rest-repository.js";
import { sharedTaskRepository } from "../shared-task-repository.js";
import type { TaskButtonRow } from "./task-button-repository.js";

export const STALE_TASK_ACTIONS = ["postpone_week", "cancel", "keep"] as const;
export type StaleTaskAction = typeof STALE_TASK_ACTIONS[number];

export function isStaleTaskAction(action: TaskButtonRow["action"]): action is StaleTaskAction {
  return (STALE_TASK_ACTIONS as readonly string[]).includes(action);
}

/** «Через неделю» moves the date seven days from today; a task with a time keeps its time. */
const POSTPONE_DAYS = 7;

interface TaskNow {
  readonly dueAt: string | null;
  readonly dueOn: string | null;
  readonly title: string;
  readonly version: number;
}

export interface StaleTaskPressDependencies {
  read(auth: MemoryAuthorization, id: string): Promise<TaskNow>;
  change(auth: MemoryAuthorization, input: Record<string, unknown>, operationKey: string): Promise<TaskNow>;
  rest(input: { familyId: string; taskId: string; taskVersion: number; userId: string }): Promise<void>;
  timezone(auth: MemoryAuthorization): Promise<string>;
}

export const staleTaskPressDependencies: StaleTaskPressDependencies = {
  async read(auth, id) {
    const result = await sharedTaskRepository.execute(auth, { action: "get", id }, `stale-read:${id}`) as { task: TaskNow };
    return result.task;
  },
  async change(auth, input, operationKey) {
    const result = await sharedTaskRepository.execute(auth, input as never, operationKey) as { task: TaskNow };
    return result.task;
  },
  rest: (input) => overviewRestRepository.rest(input),
  timezone: async (auth) => await currentTimeRepository.findTurnTimezone(auth.userId, auth.familyId) ?? "UTC",
};

function plusDays(isoDate: string, days: number): string {
  const at = new Date(`${isoDate}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function dayLabel(isoDate: string): string {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC", weekday: "short" })
    .format(new Date(`${isoDate}T12:00:00Z`));
}

/** The line that replaces the buttons: what was done, in the person's words. */
export function pressStaleTask(
  dependencies: StaleTaskPressDependencies,
  input: { auth: MemoryAuthorization; now: Date; operationKey: string; row: TaskButtonRow & { action: StaleTaskAction } },
): Promise<string> {
  return answerStaleTask(dependencies, {
    action: input.row.action, auth: input.auth, id: input.row.taskId!, now: input.now, operationKey: input.operationKey,
    version: input.row.taskVersion!,
  });
}

/** The same answer from the chat button and from the Mini App's one-by-one review (`web-app-stale-api.ts`). */
export async function answerStaleTask(
  dependencies: StaleTaskPressDependencies,
  input: { action: StaleTaskAction; auth: MemoryAuthorization; id: string; now: Date; operationKey: string; version: number },
): Promise<string> {
  const { auth, id, version } = input;
  if (input.action === "cancel") {
    const task = await dependencies.change(auth, { action: "cancel", id, version }, input.operationKey);
    return `Снято: ${task.title}`;
  }
  if (input.action === "keep") {
    const task = await dependencies.read(auth, id);
    // Kept at the version the message was about: a change since then is a new situation.
    if (task.version !== version) return `Дело уже изменили, оно снова в сводке: ${task.title}`;
    await dependencies.rest({ familyId: auth.familyId, taskId: id, taskVersion: version, userId: auth.userId! });
    return `Оставлено как есть: ${task.title}. В сводке появится, когда дело изменится.`;
  }
  const task = await dependencies.read(auth, id);
  const timezone = await dependencies.timezone(auth);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(input.now);
  if (task.dueAt) {
    // Today + 7 in the person's calendar at the same local time: not the old date + 7 × 24 h, which moved the hour
    // across a DST change and gave another answer to a replayed press (ревью 21 октября 2026).
    const day = plusDays(today, POSTPONE_DAYS);
    const dueAt = zonedInstant(day, localClock(task.dueAt, timezone), timezone);
    const changed = await dependencies.change(auth, { action: "update", dueAt: dueAt.toISOString(), id, version }, input.operationKey);
    return `Перенесено на ${dayLabel(day)}: ${changed.title}`;
  }
  const dueOn = plusDays(today, POSTPONE_DAYS);
  const changed = await dependencies.change(auth, { action: "update", dueOn, id, version }, input.operationKey);
  return `Перенесено на ${dayLabel(dueOn)}: ${changed.title}`;
}

/** The question is answered once: its text gets the outcome line and the keyboard goes. A failed edit only logs. */
export async function replaceButtonsWithLine(
  editText: (input: { chatId: string; keyboard: []; messageId: string; text: string }) => Promise<void>,
  query: TelegramCallbackQuery,
  line: string,
): Promise<void> {
  const said = query.raw.message as { text?: unknown } | undefined;
  if (typeof said?.text !== "string" || !query.message) return;
  await editText({ chatId: query.message.chat.id, keyboard: [], messageId: query.message.messageId, text: `${said.text}\n\n${line}` })
    .catch((error: unknown) => console.error(JSON.stringify({
      code: "AGENT_TASK_BUTTON_REDRAW_FAILED", error: error instanceof Error ? error.message : String(error),
    })));
}

/** «HH:MM» of an instant in a time zone. */
export function localClock(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", minute: "2-digit", timeZone: timezone })
    .format(new Date(iso));
}

/** The instant a wall clock in `timezone` shows `day` at `clock`; two passes settle the offset around a DST change. */
export function zonedInstant(day: string, clock: string, timezone: string): Date {
  const wall = Date.parse(`${day}T${clock}:00Z`);
  const offset = (at: number) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "2-digit", timeZone: timezone, year: "numeric",
    }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - at;
  };
  const first = wall - offset(wall);
  return new Date(wall - offset(first));
}
