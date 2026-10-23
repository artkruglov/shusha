/**
 * «Закрытые за неделю» в Mini App: что сделано и что снято с понедельника по воскресенье по дню человека.
 *
 * Exports:
 * - `ClosedCandidate`, `WebAppClosedWeek`, `WebAppClosedRow`: сырьё из базы и то, что получает страница.
 * - `weekOf`: понедельник и воскресенье недели, в которую попадает день.
 * - `webAppClosedWeek`: строки недели, сгруппированные на «Сделано» и «Снятые».
 *
 * Неделя считается по дате закрытия (`shared_task_versions`), а не по сроку: дело со сроком в прошлом месяце,
 * закрытое вчера, относится к этой неделе. Обычное дело попадает сюда, только если оно и сейчас закрыто,
 * последним своим закрытием; повторяющееся каждым выполнением, и «Вернуть» у него нет (как в квитанции чата).
 * Видимость решает репозиторий дел: в выдачу идут только дела, которые он отдал человеку по `get`.
 */
import { longDay } from "./web-app-task-card.js";

export interface ClosedCandidate {
  readonly taskId: string;
  readonly action: "cancel" | "complete";
  readonly actorTelegramId: string;
  readonly at: Date;
  readonly repeat: boolean;
  readonly creatorTelegramId: string;
  readonly assigneeTelegramId: string | null;
}

export interface WebAppClosedRow {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly detail: string;
  readonly canReopen: boolean;
  readonly repeat: boolean;
}

export interface WebAppClosedWeek {
  readonly from: string;
  readonly until: string;
  readonly label: string;
  readonly done: readonly WebAppClosedRow[];
  readonly cancelled: readonly WebAppClosedRow[];
}

function shift(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function weekOf(day: string): { from: string; until: string } {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const from = shift(day, -((weekday + 6) % 7));
  return { from, until: shift(from, 6) };
}

function rangeLabel(from: string, until: string): string {
  const [first, last] = [longDay(from), longDay(until)];
  const [firstDay, firstMonth] = first.split(" ");
  return firstMonth === last.split(" ")[1] ? `${firstDay}–${last}` : `${first} – ${last}`;
}

export function webAppClosedWeek(
  week: { from: string; until: string },
  candidates: readonly ClosedCandidate[],
  tasks: ReadonlyMap<string, { title: string; version: number }>,
  facts: { names: ReadonlyMap<string, string>; timezone: string; viewerTelegramId: string },
): WebAppClosedWeek {
  const rows = (action: ClosedCandidate["action"]) => candidates
    .filter((candidate) => candidate.action === action && tasks.has(candidate.taskId))
    .sort((left, right) => right.at.getTime() - left.at.getTime())
    .map((candidate) => {
      const task = tasks.get(candidate.taskId)!;
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: facts.timezone }).format(candidate.at);
      const own = candidate.assigneeTelegramId === facts.viewerTelegramId || candidate.creatorTelegramId === facts.viewerTelegramId;
      return {
        canReopen: own && !candidate.repeat,
        detail: `${facts.names.get(candidate.actorTelegramId) ?? "Участник"} · ${longDay(day)}`,
        id: candidate.taskId,
        repeat: candidate.repeat,
        title: task.title,
        version: task.version,
      };
    });
  return { cancelled: rows("cancel"), done: rows("complete"), from: week.from, label: rangeLabel(week.from, week.until), until: week.until };
}
