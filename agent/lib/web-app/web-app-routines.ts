/**
 * «Напоминания и регулярное» в Mini App: напоминания человека и регулярные задания бота, с переключателем.
 *
 * Exports:
 * - `WebAppRoutine`, `WebAppRoutines`: то, что получает страница.
 * - `repeatLabel`, `whenLabel`: подписи «Каждый день в 8:00», «По пятницам», «Сегодня, 19:00».
 * - `webAppRoutines`: список, включить или выключить, удалить и «Запустить сейчас» через `reminderRepository`
 *   и `agentScheduleRepository` с правами лички (`privateReminderAuthorization`).
 *
 * Видно то же, что инструментам `list_reminders` и `list_agent_schedules` в личке: личные напоминания человека
 * и семейные его области. Можно ли выключить или удалить запись, решает репозиторий, как и в чате; страница
 * присылает только id и что сделать. Последний запуск записи не хранят, поэтому показан следующий.
 */
import { agentScheduleRepository } from "../agent-schedules/agent-schedule-repository.js";
import type { AgentScheduleRecord } from "../agent-schedules/agent-schedule-record.js";
import type { MemoryAuthorization } from "../memory-context.js";
import type { ReminderRecord } from "../reminders/reminder-record.js";
import { reminderRepository } from "../reminders/reminder-repository.js";
import { localDate } from "../task-board.js";
import { privateReminderAuthorization } from "./web-app-settings.js";
import { longDay } from "./web-app-task-card.js";

const PAGE_SIZE = 50;
/** Родительный падеж для «По пятницам» и именительный для перечня: 0 это воскресенье. */
const WEEKDAYS_PLURAL = ["воскресеньям", "понедельникам", "вторникам", "средам", "четвергам", "пятницам", "субботам"] as const;

export interface WebAppRoutine {
  readonly id: string;
  readonly kind: "reminder" | "schedule";
  readonly title: string;
  readonly repeat: string | null;
  readonly next: string | null;
  readonly enabled: boolean;
  readonly scope: string;
  readonly failed: boolean;
}

export interface WebAppRoutines {
  readonly schedules: readonly WebAppRoutine[];
  readonly reminders: readonly WebAppRoutine[];
}

function clock(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", { hour: "numeric", minute: "2-digit", timeZone: timezone }).format(at);
}

export function whenLabel(iso: string, timezone: string, now: Date): string {
  const at = new Date(iso);
  const day = localDate(timezone, at);
  const today = localDate(timezone, now);
  const tomorrow = localDate(timezone, new Date(now.getTime() + 86_400_000));
  const name = day === today ? "Сегодня" : day === tomorrow ? "Завтра" : longDay(day);
  return `${name}, ${clock(at, timezone)}`;
}

export function repeatLabel(
  recurrence: { unit: "daily" | "monthly" | "weekly"; interval: number; daysOfWeek?: readonly number[] } | null,
  next: string,
  timezone: string,
): string | null {
  if (recurrence === null) return null;
  const at = new Date(next);
  const time = clock(at, timezone);
  const every = recurrence.interval > 1;
  if (recurrence.unit === "daily") return every ? `Раз в ${recurrence.interval} дня в ${time}` : `Каждый день в ${time}`;
  if (recurrence.unit === "monthly") return every ? `Раз в ${recurrence.interval} месяца` : `Каждый месяц ${longDay(localDate(timezone, at)).split(" ")[0]}-го`;
  const weekday = new Date(`${localDate(timezone, at)}T00:00:00Z`).getUTCDay();
  const days = recurrence.daysOfWeek && recurrence.daysOfWeek.length > 0 ? recurrence.daysOfWeek : [weekday];
  if (days.length === 7) return `Каждый день в ${time}`;
  const set = new Set(days);
  const lead = every ? `Раз в ${recurrence.interval} недели, по` : "По";
  // Monday to Friday and the two weekend days have their own words, as people say them.
  if (set.size === 5 && [1, 2, 3, 4, 5].every((day) => set.has(day))) return `${lead} будням в ${time}`;
  if (set.size === 2 && set.has(0) && set.has(6)) return `${lead} выходным в ${time}`;
  const names = [...set].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((day) => WEEKDAYS_PLURAL[day]!);
  const listed = names.length > 1 ? `${names.slice(0, -1).join(", ")} и ${names.at(-1)}` : names[0];
  return `${lead} ${listed} в ${time}`;
}

const isOn = (status: string) => status === "active" || status === "leased";

function reminderRow(record: ReminderRecord, now: Date): WebAppRoutine {
  const live = record.status !== "completed";
  return {
    enabled: isOn(record.status), failed: record.status === "failed", id: record.id, kind: "reminder",
    next: live ? whenLabel(record.nextRunAt, record.timezone, now) : null,
    repeat: repeatLabel(record.recurrence, record.nextRunAt, record.timezone),
    scope: record.scope, title: record.content,
  };
}

function scheduleRow(record: AgentScheduleRecord, now: Date): WebAppRoutine {
  const recurrence = record.recurrence.kind === "once" ? null
    : record.recurrence.kind === "daily" ? { interval: record.recurrence.interval, unit: "daily" as const }
      : { daysOfWeek: record.recurrence.daysOfWeek, interval: record.recurrence.interval, unit: "weekly" as const };
  return {
    enabled: isOn(record.status), failed: record.status === "failed", id: record.id, kind: "schedule",
    next: record.status === "completed" ? null : whenLabel(record.nextRunAt, record.timezone, now),
    repeat: repeatLabel(recurrence, record.nextRunAt, record.timezone),
    scope: record.scope, title: record.title,
  };
}

export const webAppRoutines = {
  async list(auth: MemoryAuthorization, now: Date): Promise<WebAppRoutines> {
    const routineAuth = privateReminderAuthorization(auth);
    const [reminders, schedules] = await Promise.all([
      reminderRepository.list(routineAuth, { limit: PAGE_SIZE }),
      agentScheduleRepository.list(routineAuth, { limit: PAGE_SIZE }),
    ]);
    // A finished one-off is history, not something to switch: the chat's list keeps it, the page does not.
    return {
      reminders: reminders.items.filter((item) => item.status !== "completed").map((item) => reminderRow(item, now)),
      schedules: schedules.items.filter((item) => item.status !== "completed").map((item) => scheduleRow(item, now)),
    };
  },

  async setEnabled(auth: MemoryAuthorization, kind: WebAppRoutine["kind"], id: string, enabled: boolean, operationKey: string): Promise<void> {
    const routineAuth = privateReminderAuthorization(auth);
    if (kind === "reminder") await reminderRepository.update(routineAuth, id, { enabled, operationKey });
    else await agentScheduleRepository.update(routineAuth, id, { enabled, operationKey });
  },

  async remove(auth: MemoryAuthorization, kind: WebAppRoutine["kind"], id: string, operationKey: string): Promise<void> {
    const routineAuth = privateReminderAuthorization(auth);
    if (kind === "reminder") await reminderRepository.delete(routineAuth, id, operationKey);
    else await agentScheduleRepository.delete(routineAuth, id, operationKey);
  },

  async runNow(auth: MemoryAuthorization, id: string, operationKey: string): Promise<void> {
    await agentScheduleRepository.runNow(privateReminderAuthorization(auth), id, operationKey);
  },
};
