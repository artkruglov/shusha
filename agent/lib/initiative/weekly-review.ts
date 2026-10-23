/**
 * Недельный обзор: раз в неделю показать то, что не попадает в утренний список.
 *
 * Экспорт:
 * - `WeeklyReviewInput`: дела человека и счётчик закрытого за неделю.
 * - `WEEKLY_REVIEW_QUESTIONS`: ровно три вопроса обзора.
 * - `formatWeeklyReview`: текст обзора либо `null`, когда пересматривать нечего.
 *
 * Истории T16 и B08, еженедельный пересмотр из GTD. Утренний обзор отвечает на «что сегодня», и
 * дело без срока в него не попадает никогда: оно живёт в списке месяцами, пока о нём не спросят.
 * Здесь собрано ровно то, что утро не показывает: просроченное, ожидание чужого ответа и дела без
 * срока и без личного плана. Раздел так и называется: «позвонить мастеру» без даты это конкретный
 * шаг, и «без следующего шага» говорило о нём неправду (замечание Codex, 16 октября 2026).
 *
 * Чего здесь нет: советов, счёта вклада и серий («третья неделя подряд»). Обзор задаёт три вопроса и
 * предлагает действие, решение остаётся за человеком, а одна фраза его выключает. С 21 октября 2026
 * (владелец: коуч должен спрашивать, почему в сфере пусто) обзор показывает сферы жизни и спрашивает об одной
 * пустой: «Для себя» пусто — это сознательно? Это вопрос, а не упрёк, и только о сфере, не о человеке. Молчание это нормальный исход: неделя без просроченного, без ожидания и без
 * подвисших дел проходит без сообщения, и неделя одних идей тоже — идея ничего не обещает
 * (история B01), и напоминать о ней раз в неделю значит превращать её в долг.
 */
import { LIFE_AREAS, lifeAreaTitle, type LifeArea } from "../life-areas.js";
import {
  cleanTaskTitle, dueDay, isOverdue, localDate, OPEN_TASK_STATUSES, shortDate, type BoardProject, type BoardTask,
} from "../task-board.js";

export interface WeeklyReviewInput {
  /** Открытые дела, идеи и традиции человека из всех его областей. */
  readonly tasks: readonly BoardTask[];
  /** Его просьбы другим, на которые ещё не ответили. */
  readonly waiting: readonly BoardTask[];
  /** Сколько выполнений за последние семь дней: дело один раз, повторяющееся каждым вхождением. */
  readonly closedLastWeek: number;
  readonly now: Date;
  /** Пояс человека: «просрочено» считается в его дне. */
  readonly timezone: string;
  /** Живые проекты человека со счётом дел: без следующего шага и с готовым результатом. */
  readonly projects?: readonly BoardProject[];
}

/** Три вопроса и не больше: длинная анкета остаётся без ответа целиком. */
export const WEEKLY_REVIEW_QUESTIONS = [
  "Что на этой неделе помогло?",
  "Что давит?",
  "Что можно убрать?",
] as const;

export const WEEKLY_REVIEW_OFFER = "Скажи, что закрыть, отложить, передать или снять — сделаю.";
export const WEEKLY_REVIEW_OPT_OUT = "«Хватит обзоров» — выключу.";
const PROJECT_NO_STEP_HINT = "Скажи первый шаг.";
const PROJECT_DONE_HINT = "Закрыть?";
/** Столько строк на раздел: обзор для пересмотра, а не полный список, он уже есть по просьбе. */
const PER_SECTION = 5;

/** Дело без срока и без личного плана: записано и не начато, именно оно и теряется. */
function withoutNextStep(task: BoardTask, timezone: string): boolean {
  return task.kind === "task" && dueDay(task, timezone) === null
    && !task.plannedFrom && !task.plannedUntil;
}

/** Порядок, в котором пустая сфера становится вопросом: сначала то, что тонет под срочным. */
const QUIET_FIRST: readonly LifeArea[] = ["self", "couple", "kids", "home", "work"];

/**
 * Сферы жизни недели: сколько открытого в каждой (по сфере дела, иначе его проекта) и вопрос об одной пустой.
 * Пусто показывается только когда размечена хотя бы половина дел: иначе «пусто» значит «не размечено».
 */
function sphereLines(open: readonly BoardTask[], projects: readonly BoardProject[]): string[] | null {
  const tasks = open.filter((task) => task.kind === "task");
  const areaOf = (task: BoardTask) => task.lifeArea ?? projects.find((project) => project.id === task.projectId)?.lifeArea ?? null;
  const counts = new Map<LifeArea, number>();
  for (const task of tasks) {
    const area = areaOf(task);
    if (area) counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  const marked = [...counts.values()].reduce((sum, n) => sum + n, 0);
  if (marked === 0 || marked * 2 < tasks.length) return null;
  const line = LIFE_AREAS.filter((area) => counts.has(area)).map((area) => `${lifeAreaTitle(area)} ${counts.get(area)}`).join(" · ");
  const empty = QUIET_FIRST.find((area) => !counts.has(area));
  return [`Сферы: ${line}`, ...(empty ? [`В «${lifeAreaTitle(empty)}» на эту неделю ничего нет. Это сознательно или руки не дошли?`] : [])];
}

export function formatWeeklyReview(input: WeeklyReviewInput): string | null {
  const today = localDate(input.timezone, input.now);
  const open = input.tasks.filter((task) => OPEN_TASK_STATUSES.has(task.status));
  const overdue = open.filter((task) => task.kind === "task" && isOverdue(task, input.now, today));
  const waiting = input.waiting.filter((task) => OPEN_TASK_STATUSES.has(task.status));
  const stalled = open.filter((task) => !overdue.includes(task) && withoutNextStep(task, input.timezone));
  const ideas = open.filter((task) => task.kind === "idea").length;

  // Проект без открытого дела это вопрос человеку: нет следующего шага (GTD) или результат готов.
  const quiet = (input.projects ?? []).filter((project) => project.status === "accepted" && project.open === 0);
  const noStep = quiet.filter((project) => project.completed === 0);
  const finished = quiet.filter((project) => project.completed > 0);

  // Пересматривать нечего: обзор ни о чём приучает не читать обзоры вовсе.
  if (overdue.length === 0 && waiting.length === 0 && stalled.length === 0 && noStep.length === 0 && finished.length === 0) return null;

  const lines: string[] = ["Обзор недели."];
  if (input.closedLastWeek > 0) lines.push("", `За неделю закрыто: ${input.closedLastWeek}.`);

  const section = (title: string, tasks: readonly BoardTask[], suffix: (task: BoardTask) => string) => {
    if (tasks.length === 0) return;
    const shown = tasks.slice(0, PER_SECTION);
    const more = tasks.length - shown.length;
    lines.push("", `${title} · ${tasks.length}`,
      ...shown.map((task) => `• ${cleanTaskTitle(task.title, "plain")}${suffix(task)}`),
      ...(more > 0 ? [`…и ещё ${more}`] : []));
  };

  section("⚠️ Просрочено", overdue, (task) => ` — срок ${shortDate(dueDay(task, input.timezone)!)}`);
  section("Жду ответа", waiting, () => "");
  section("Без срока и плана", stalled, () => "");
  const projectSection = (title: string, projects: readonly BoardProject[], hint: string) => {
    if (projects.length === 0) return;
    const shown = projects.slice(0, PER_SECTION);
    const more = projects.length - shown.length;
    lines.push("", `${title} · ${projects.length}`,
      ...shown.map((project) => `• ${cleanTaskTitle(project.title, "plain")}`),
      ...(more > 0 ? [`…и ещё ${more}`] : []), hint);
  };
  projectSection("Проекты без следующего шага", noStep, PROJECT_NO_STEP_HINT);
  projectSection("Проекты, где всё сделано", finished, PROJECT_DONE_HINT);
  if (ideas > 0) lines.push("", `Идей на «когда-нибудь»: ${ideas}.`);
  const spheres = sphereLines(open, input.projects ?? []);
  if (spheres) lines.push("", ...spheres);

  return [...lines, "", ...WEEKLY_REVIEW_QUESTIONS, "", WEEKLY_REVIEW_OFFER, WEEKLY_REVIEW_OPT_OUT]
    .join("\n");
}
