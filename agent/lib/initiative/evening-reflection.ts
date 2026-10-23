/**
 * Итог дня вечером: что сделано, что осталось, шаг по проекту и вопрос о главном на завтра.
 *
 * Экспорт:
 * - `EVENING_REFLECTION_TITLES`: сколько названий показывать строками.
 * - `EVENING_REFLECTION_QUESTION`, `EVENING_REFLECTION_FIRST_LINE`: вопрос и объяснение первого раза.
 * - `EveningReflectionInput`: собранное за день.
 * - `eveningReflectionInput`: из обзора дел и закрытого сегодня собирает вход без базы.
 * - `formatEveningReflection`: текст либо `null`, когда за день ничего не было.
 *
 * Владелец, 21 октября 2026: утро говорит, что на сегодня, а вечером день никто не подводит, и «главное на завтра»
 * остаётся в голове. Текст собирает код: коротко, тепло, без упрёков и счёта несделанного — оставшееся названо
 * «ещё на сегодня» с предложением перенести, а не «не сделано». Ответ человека модель записывает делом на завтра
 * (`WEEKLY_REVIEW_REPLY_RULES`). Сообщение приходит только тому, у кого день что-то содержал: закрытое им сегодня
 * или открытое с сегодняшним сроком. Шаг проекта только дополняет такой итог: один шаг со сроком через месяц не
 * повод писать «итог дня» (ревью 23 октября 2026), как обещает строка первого раза. Чужие личные дела сюда не попадают: открытое берётся из того же
 * обзора, что видит сам человек, закрытое — только им самим и только в личной и семейной областях.
 */
import { cleanTaskTitle, dueDay, localDate, type BoardTask } from "../task-board.js";
import type { DailyOverview, OverviewTask } from "./daily-overview.js";
import { projectStep } from "./daily-overview-short.js";

export const EVENING_REFLECTION_TITLES = { closed: 3, open: 2 } as const;
export const EVENING_REFLECTION_QUESTION = "Что главное завтра? Ответь — запишу.";
export const EVENING_REFLECTION_FIRST_LINE = "Пишу так вечером, только если за день что-то было. Не нужно — нажми «Не писать вечером».";

export interface EveningReflectionInput {
  /** Закрытое им сегодня, по времени закрытия. */
  readonly closed: readonly string[];
  /** Его принятые дела со сроком сегодня, ещё открытые. */
  readonly openToday: readonly string[];
  readonly projectLine: string | null;
  /** Итог дня приходит впервые: одна строка о том, как выключить. */
  readonly first: boolean;
}

function isToday(task: BoardTask, today: string, timezone: string): boolean {
  if (dueDay(task, timezone) === today) return true;
  return Boolean(task.plannedFrom && task.plannedUntil && task.plannedFrom <= today && task.plannedUntil >= today);
}

export function eveningReflectionInput(
  overview: DailyOverview, closed: readonly string[], first: boolean,
): EveningReflectionInput {
  const today = localDate(overview.timezone, overview.now);
  const mine = overview.tasks.filter((task) => task.kind === "task" && task.status === "accepted");
  const openToday: OverviewTask[] = mine.filter((task) => isToday(task, today, overview.timezone));
  return {
    closed,
    first,
    openToday: openToday.map((task) => task.title),
    projectLine: projectStep(overview, mine, openToday),
  };
}

function section(title: string, titles: readonly string[], limit: number): string[] {
  if (titles.length === 0) return [];
  const count = titles.length > limit ? `${titles.length} · показано ${limit}` : `${titles.length}`;
  return ["", `${title} · ${count}`, ...titles.slice(0, limit).map((name) => `• ${cleanTaskTitle(name, "plain")}`)];
}

export function formatEveningReflection(input: EveningReflectionInput): string | null {
  if (input.closed.length === 0 && input.openToday.length === 0) return null;
  const lines = [
    "Добрый вечер. Короткий итог дня.",
    ...section("Сделано сегодня", input.closed, EVENING_REFLECTION_TITLES.closed),
    ...section("Ещё на сегодня", input.openToday, EVENING_REFLECTION_TITLES.open),
    ...(input.openToday.length > 0 ? ["Не успеется — скажи, перенесу на завтра."] : []),
    ...(input.projectLine ? ["", input.projectLine] : []),
    "",
    EVENING_REFLECTION_QUESTION,
    ...(input.first ? ["", EVENING_REFLECTION_FIRST_LINE] : []),
  ];
  return lines.join("\n");
}
