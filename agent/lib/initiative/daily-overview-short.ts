/**
 * Короткий утренний обзор: что человек обещал на сегодня, и кнопки, чтобы это закрыть.
 *
 * Экспорт:
 * - `SHORT_OVERVIEW_TASKS`: сколько дел обзор показывает строками и кнопками.
 * - `ShortDailyOverview`: текст, его жирные заголовки и дела, под которыми встанут кнопки.
 * - `formatShortDailyOverview`: обзор либо `null`, когда говорить не о чем.
 * - `projectStep`: одна строка о движении проекта; её же берёт итог дня (`evening-reflection.ts`).
 *
 * Доска целиком утром была простынёй, и важное обрезалось (прод, октябрь 2026). Разбор сценариев
 * 16 октября (docs/telegram-task-buttons-plan.ru.md) оставил в утреннем сообщении только принятые
 * обязательства человека: просроченное и сегодняшнее, не больше пяти, чтобы прочесть за десять
 * секунд. Ничьё и просьбы, ждущие ответа, не смешиваются с «на мне сегодня»: они идут одной строкой
 * со счётчиком, а вся доска приходит по кнопке «Все дела». Отбор дат тот же, что на доске
 * (`dueDay`, `isOverdue`), поэтому обзор и доска не расходятся.
 *
 * 21 октября 2026 (v3, `docs/design/task-lists-v3.ru.md`): одни и те же просрочки стояли по 26–31 утру, и
 * владелец решил, что обзор не должен их констатировать. Теперь «Сегодня» первым, просроченного не
 * больше двух строк, а просроченное дело, показанное три утра без изменений (`overview-rest-repository.ts`),
 * и дело, которое человек решил оставить, обзор больше не повторяет: о нём один раз приходит помощь.
 *
 * 21 октября 2026 (владелец): восемь просьб Юле висели по три недели, утро показывало только «Просят тебя · 8».
 * Теперь просьбы идут строками своим разделом, вне пяти строк своих дел и без «Оставить» и давних дел: просьба
 * уходит из утра только ответом. Тот, кто просил, через неделю без ответа видит её в «Без ответа неделю» с вопросом,
 * снять или оставить; напоминание получателю и так идёт раз в три дня (`partner-alert-repository.ts`).
 *
 * Оформление по стайлгайду (§3.3): приветствие и заголовки разделов жирные, повторяющееся дело с 🔁.
 * Жирное идёт entities Telegram, не HTML: текст остаётся простым, в журнал доставок и в контекст модели
 * попадает без разметки, а названия дел не нужно экранировать.
 */
import { cleanTaskTitle, dueDay, isOverdue, localDate, OPEN_TASK_STATUSES, shortDate, type BoardTask } from "../task-board.js";
import type { TelegramTextEntity } from "../memory-review/memory-review-owner-alert-transport.js";
import { hasCommitment, OVERVIEW_FIRST_TIME_EXPLANATION, type DailyOverview, type OverviewTask } from "./daily-overview.js";

export const SHORT_OVERVIEW_TASKS = 5;
/** Просроченного в обзоре не больше двух строк: утро начинается с того, что можно сделать сегодня. */
export const SHORT_OVERVIEW_OVERDUE = 2;
/** Просьб строками: к ним, а не к счётчику, нужен ответ человека. */
export const SHORT_OVERVIEW_REQUESTS = 2;
/** Через столько дней без ответа просьба попадает в утро того, кто просил. */
export const REQUEST_UNANSWERED_DAYS = 7;

export interface ShortDailyOverview {
  readonly text: string;
  /** Жирные приветствие и заголовки разделов; смещения в UTF-16, как считает Telegram. */
  readonly entities: readonly TelegramTextEntity[];
  /** Показанные строками дела по порядку: у каждого будет своя кнопка «✓». */
  readonly shown: readonly OverviewTask[];
  /** Показанные просроченные: только их показы считаются для сообщения о давнем деле. */
  readonly shownOverdue: readonly OverviewTask[];
  /** Открытые дела и просьбы на доске (без идей и традиций): число на кнопке «Все дела». */
  readonly openCount: number;
}

/** «YYYY-MM-DD» на `days` дней раньше или позже. */
function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Строка о проекте для утра и итога дня: ближайший шаг проекта либо проект, где шага нет. */
export function projectStep(overview: DailyOverview, mine: readonly OverviewTask[], shown: readonly OverviewTask[]): string | null {
  const live = (overview.projects ?? []).filter((project) => project.status === "accepted");
  const of = (task: OverviewTask) => live.find((project) => project.id === task.projectId || project.aliases?.includes(task.projectId ?? ""));
  const steps = mine.filter((task) => task.projectId && !shown.includes(task) && of(task))
    .sort((a, b) => (dueDay(a, overview.timezone) ?? "9999").localeCompare(dueDay(b, overview.timezone) ?? "9999")
      || (a.updatedOn ?? "").localeCompare(b.updatedOn ?? ""));
  const step = steps[0];
  if (step) return `Шаг по проекту «${cleanTaskTitle(of(step)!.title, "plain")}»: ${cleanTaskTitle(step.title, "plain")}.`;
  const empty = live.find((project) => project.open === 0 && project.completed === 0);
  return empty ? `У проекта «${cleanTaskTitle(empty.title, "plain")}» нет следующего шага. Какой он?` : null;
}

function isToday(task: BoardTask, today: string, timezone: string): boolean {
  if (dueDay(task, timezone) === today) return true;
  return Boolean(task.plannedFrom && task.plannedUntil && task.plannedFrom <= today && task.plannedUntil >= today);
}

export function formatShortDailyOverview(
  overview: DailyOverview,
  options: { first?: boolean } = {},
): ShortDailyOverview | null {
  if (!hasCommitment(overview)) return null;
  const today = localDate(overview.timezone, overview.now);
  const open = overview.tasks.filter((task) => OPEN_TASK_STATUSES.has(task.status));
  const resting = (task: OverviewTask, set?: ReadonlySet<string>) => task.id !== undefined && set?.has(task.id) === true;
  const mine = open.filter((task) => task.kind === "task" && task.status === "accepted");
  const late = mine.filter((task) => isOverdue(task, overview.now, today));
  // Повторять одно и то же просроченное каждое утро бесполезно: после сообщения о нём оно уходит, а «Оставить» убирает
  // его до правки. Только просроченное: оставленное дело в свой день снова «Сегодня».
  const overdue = late.filter((task) => !resting(task, overview.rest?.repeated) && !resting(task, overview.rest?.rested));
  const todays = mine.filter((task) => !late.includes(task) && isToday(task, today, overview.timezone));
  const shownToday = todays.slice(0, SHORT_OVERVIEW_TASKS);
  const shownOverdue = overdue.slice(0, Math.min(SHORT_OVERVIEW_OVERDUE, SHORT_OVERVIEW_TASKS - shownToday.length));

  const lines: string[] = [];
  const section = (title: string, all: readonly OverviewTask[], shown: readonly OverviewTask[], line: (task: OverviewTask) => string) => {
    if (all.length === 0) return;
    // «показано 3» вместо «…и ещё N» (стайлгайд 17.10): счёт раздела честный, а что скрыто, видно сразу.
    const count = all.length > shown.length ? `${all.length} · показано ${shown.length}` : `${all.length}`;
    lines.push("", `${title} · ${count}`, ...shown.map(line));
    headers.push(`${title} · ${count}`);
  };
  const headers: string[] = [];
  const name = (task: OverviewTask) => `${task.repeat ? "🔁 " : ""}${cleanTaskTitle(task.title, "plain")}`;
  section("Сегодня", todays, shownToday, (task) => `• ${name(task)}`);
  // Пять сегодняшних строк заняли всё место: просроченное остаётся счётчиком, без пустого заголовка.
  if (shownOverdue.length > 0) {
    section("⚠️ Просрочено", overdue, shownOverdue,
      (task) => `• ${name(task)} — срок ${shortDate(dueDay(task, overview.timezone)!)}`);
  }

  // Просьбы к человеку: ответ «беру» или «не могу» нужен от него, поэтому они видны названиями, а не числом.
  const requests = open.filter((task) => task.kind === "task" && task.status === "proposed");
  section("Просят тебя", requests, requests.slice(0, SHORT_OVERVIEW_REQUESTS), (task) => `• ${name(task)}`);
  if (requests.length > 0) lines.push("Ответь «беру» или «не могу»: кнопками в напоминании или словами здесь.");
  // Его просьбы, которые неделю ждут ответа: решает он, снять или оставить.
  const weekAgo = shiftDay(today, -REQUEST_UNANSWERED_DAYS);
  const unanswered = overview.waiting.filter((task) => task.status === "proposed" && task.updatedOn != null && task.updatedOn <= weekAgo);
  section("Без ответа неделю", unanswered, unanswered.slice(0, SHORT_OVERVIEW_REQUESTS),
    (task) => `• ${name(task)}${task.assignee ? ` — ${cleanTaskTitle(task.assignee, "plain")}` : ""}`);
  if (unanswered.length > 0) lines.push("Напоминаю им раз в три дня. Снять или оставить? Ответь здесь.");

  // Коуч проектов (владелец, 21 октября 2026): одна строка о движении, а не список. Шаг ближайшего по сроку
  // проекта, которого ещё нет в строках выше; иначе проект без следующего шага с вопросом.
  // Просроченное, убранное «Оставить» или уже названное, не возвращается и сюда (ревью 23 октября 2026).
  const projectLine = projectStep(overview, mine.filter((task) => !late.includes(task) || overdue.includes(task)),
    [...shownToday, ...shownOverdue]);
  if (projectLine) lines.push("", projectLine);

  const rest = mine.length - overdue.length - todays.length;
  const unowned = open.filter((task) => task.kind === "task" && task.status === "open").length;
  // Просьба другому тоже повод для утра (`hasCommitment`): без счётчика обзор приходил пустым.
  const asked = overview.waiting.filter((task) => OPEN_TASK_STATUSES.has(task.status)).length;
  // Две короткие строки вместо одной длинной (ревью 21 октября 2026): своё, затем чужое и общее.
  // Слова из общего словаря: «Никто не взял», «Просят тебя», «Ты просишь».
  const join = (parts: readonly (string | null)[]) => parts.filter((part): part is string => part !== null).join(" · ");
  const ownLine = join([
    shownOverdue.length === 0 && overdue.length > 0 ? `⚠️ Просрочено · ${overdue.length}` : null,
    rest > 0 ? `Ещё дел · ${rest}` : null,
  ]);
  const othersLine = join([
    unowned > 0 ? `Никто не взял · ${unowned}` : null,
    asked > 0 ? `Ты просишь · ${asked}` : null,
  ]);
  const tail = [ownLine, othersLine].filter((line) => line.length > 0);
  if (tail.length > 0) lines.push("", ...tail);

  const greeting = overdue.length + todays.length > 0 ? "Доброе утро." : "Доброе утро. На сегодня сроков нет.";
  const text = [
    greeting, ...lines,
    ...(overview.areas && overview.areas.length > 0 ? ["", `Твои области: ${overview.areas.join(", ")}.`] : []),
    ...(options.first === true ? ["", OVERVIEW_FIRST_TIME_EXPLANATION] : []),
  ].join("\n");
  // То же число, что «Открытых · N» на доске, которую присылает «Все дела» (`task-board-rich.ts`).
  const openCount = open.filter((task) => task.kind === "task").length;
  return { entities: boldLines(text, [greeting, ...headers]), openCount, shown: [...shownToday, ...shownOverdue], shownOverdue, text };
}

/** Bold over each of these whole lines, found in order; JavaScript string offsets are UTF-16, as Telegram's. */
function boldLines(text: string, bold: readonly string[]): TelegramTextEntity[] {
  const entities: TelegramTextEntity[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    if (bold.includes(line) && line.length > 0) entities.push({ length: line.length, offset, type: "bold" });
    offset += line.length + 1;
  }
  return entities;
}
