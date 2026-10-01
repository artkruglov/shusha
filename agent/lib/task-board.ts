/**
 * Доска дел: весь открытый список перед глазами, оформленный кодом, а не моделью.
 *
 * Exports:
 * - `BoardTask`: поля строки списка, которых хватает для доски.
 * - `formatTaskBoard`: текст доски или `null`, когда показывать нечего.
 * - `taskBoardReply`: та же доска для ответа модели, защищённая от автоката.
 * - `OPEN_TASK_STATUSES`, `isOverdue`, `dueDay`, `shortDate`, `localDate`, `cleanTaskTitle`: разбор строки для
 *   другого детерминированного текста о тех же делах (недельный обзор), чтобы даты и обрезка
 *   названий считались здесь один раз, а не повторялись рядом.
 *
 * Раньше утренний обзор показывал только дела со сроком на сегодня, а «покажи дела» модель
 * пересказывала сплошным абзацем через запятую, и автокат прятал середину под «Полный ответ».
 * Здесь порядок один и тот же: просроченное, сегодня, затем все открытые дела по спискам,
 * идеи отдельно как «Когда-нибудь», просьбы другим отдельно. Одно дело на строку.
 */
import { lifeAreaTitle, type LifeArea } from "./life-areas.js";
import { TELEGRAM_KEEP_OPEN_DIRECTIVE } from "./telegram-final-presentation.js";

export interface BoardTask {
  readonly title: string;
  /** Сфера жизни, если человек её назвал: она становится заголовком вместо имени списка. */
  readonly lifeArea?: LifeArea | null;
  readonly status: string;
  /** Кому предложено дело или кто его ведёт: имя называет, чьего ответа ждёт предложение. */
  readonly assignee?: string | null;
  readonly kind: string;
  readonly listName: string | null;
  readonly source: string;
  readonly dueOn: string | null;
  readonly dueAt: string | null;
  readonly plannedFrom?: string | null;
  readonly plannedUntil?: string | null;
  /** Проект дела (миграция 161): по нему доска находит прогресс. */
  readonly projectId?: string | null;
}

/** Проект области со счётом дел: прогресс в заголовке раздела и разделы без шага и «всё сделано». */
export interface BoardProject {
  readonly completed: number;
  readonly hasNextStep: boolean;
  readonly id: string;
  readonly open: number;
  readonly source: string;
  readonly status: string;
  readonly title: string;
  readonly total: number;
}

export interface TaskBoardInput {
  /** Открытые дела, идеи и традиции человека. */
  readonly tasks: readonly BoardTask[];
  /** Его просьбы другим, на которые ещё не ответили. */
  readonly waiting?: readonly BoardTask[];
  readonly now: Date;
  readonly timezone: string;
  /** plain для служебных сообщений без разметки, rich для ответа модели. */
  readonly style: "plain" | "rich";
  readonly perGroup?: number;
  /** Живые проекты области; без них доска остаётся прежней, без прогресса и новых разделов. */
  readonly projects?: readonly BoardProject[];
}

export const OPEN_TASK_STATUSES: ReadonlySet<string> = new Set(["open", "proposed", "accepted"]);
/** Потолок доски: утренний обзор уходит одним сообщением, предел Telegram 4096 знаков. */
export const TASK_BOARD_MAX_CHARACTERS = 3500;
const TASK_BOARD_MAX_TITLE = 120;
const NO_LIST = "Без списка";
const UNSORTED_HINT = "Скажи, куда положить или какой первый шаг.";
// Ничьё дело не обещание: на проде 1 октября 2026 их было 19, и они висели рядом с делами, которые
// кто-то ведёт. Раздел называет это прямо и говорит человеку, что с этим сделать.
const UNOWNED_SECTION_LIMIT = 10;
const NO_STEP_HINT = "Скажи первый шаг.";
const ALL_DONE_HINT = "Закрыть?";
/** Прогресс показывается, когда он что-то говорит: от трёх дел в проекте и хотя бы одного сделанного. */
const PROGRESS_MIN_TOTAL = 3;
const UNOWNED_HINT = "Никто не взял. Скажи «беру» или назови, кому.";
const PERSONAL_SOURCE = "Личное";

export function localDate(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(at);
}

export function shortDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${day}.${month}`;
}

export function dueDay(task: BoardTask, timezone: string): string | null {
  if (task.dueOn) return task.dueOn;
  return task.dueAt ? localDate(timezone, new Date(task.dueAt)) : null;
}

export function isOverdue(task: BoardTask, now: Date, today: string): boolean {
  // Срок-время прошёл по часам, срок-дата прошёл, когда наступил следующий день.
  if (task.dueAt) return new Date(task.dueAt).getTime() < now.getTime();
  return task.dueOn !== null && task.dueOn < today;
}

function isToday(task: BoardTask, today: string, timezone: string): boolean {
  if (dueDay(task, timezone) === today) return true;
  return Boolean(task.plannedFrom && task.plannedUntil && task.plannedFrom <= today && task.plannedUntil >= today);
}

/**
 * Название дела пишет человек, а доска попадает в чужой чат: ссылка, код или `**` из названия
 * иначе становятся разметкой в доске другого участника. В rich-стиле разметка гасится обратной
 * косой чертой, длинное название обрезается, чтобы одна запись не съела весь бюджет сообщения.
 */
export function cleanTaskTitle(title: string, style: TaskBoardInput["style"]): string {
  const flat = title.replace(/\s+/gu, " ").trim();
  const short = flat.length > TASK_BOARD_MAX_TITLE ? `${flat.slice(0, TASK_BOARD_MAX_TITLE - 1)}…` : flat;
  return style === "rich" ? short.replace(/[\\*_`~|[\]()<>=]/gu, "\\$&") : short;
}

function note(task: BoardTask): string {
  if (task.status === "open") return " · ничьё";
  if (task.status === "proposed") return task.assignee ? ` · ждёт согласия: ${task.assignee}` : " · ждёт согласия";
  return "";
}

export function formatTaskBoard(input: TaskBoardInput): string | null {
  const perGroup = input.perGroup ?? 5;
  const today = localDate(input.timezone, input.now);
  const heading = (text: string) => input.style === "rich" ? `**${text}**` : text;
  // Ответ модели уходит как Telegram Rich Markdown, где одиночный перевод строки это пробел:
  // строки секции склеивались в абзац. В разметке каждая строка обязана быть своим блоком,
  // поэтому там настоящий список `-` и пустая строка после заголовка. Служебное сообщение
  // (утренний обзор) уходит без разметки, и ему нужен ровно обратный, дословный вид.
  const rich = input.style === "rich";
  const item = (task: BoardTask, suffix = "", withNote = true) =>
    `${rich ? "-" : "•"} ${cleanTaskTitle(task.title, input.style)}${suffix}${withNote ? note(task) : ""}`;

  const open = input.tasks.filter((task) => OPEN_TASK_STATUSES.has(task.status));
  const commitments = open.filter((task) => task.kind === "task");
  const overdue = commitments.filter((task) => isOverdue(task, input.now, today));
  const todays = commitments.filter((task) => !overdue.includes(task) && isToday(task, today, input.timezone));
  const later = commitments.filter((task) => !overdue.includes(task) && !todays.includes(task));
  // Ничьё и ещё не принятое видно отдельно от дел, которые кто-то ведёт: по списку их не отличить,
  // и свободное дело лежало среди живых как такое же (прод 1 октября 2026: 19 ничьих из 29 семейных).
  const unowned = later.filter((task) => task.status === "open");
  const unaccepted = later.filter((task) => task.status === "proposed");
  const owned = later.filter((task) => !unowned.includes(task) && !unaccepted.includes(task));
  // Что ещё нигде не лежит и ничего не обещает по времени: раньше это уходило в «Без списка»
  // последним разделом, и никто не просил его разобрать (прод 29 сентября 2026: 21 дело из 56).
  const unsorted = owned.filter((task) => !task.listName && !task.lifeArea && dueDay(task, input.timezone) === null && !task.plannedFrom);
  const rest = owned.filter((task) => !unsorted.includes(task));
  const ideas = open.filter((task) => task.kind === "idea");
  const rituals = open.filter((task) => task.kind === "ritual");
  const waiting = (input.waiting ?? []).filter((task) => OPEN_TASK_STATUSES.has(task.status));

  const sections: string[][] = [];
  const section = <Row>(title: string, rows: readonly Row[], line: (row: Row) => string, hint?: string, limit = perGroup, progress = "") => {
    if (rows.length === 0) return;
    const shown = rows.slice(0, limit).map(line);
    const more = rows.length - shown.length;
    // Хвост «…и ещё N» и подсказка это отдельные абзацы: без пустой строки разметка считает их
    // продолжением последнего пункта списка и печатает внутри пункта.
    sections.push([heading(`${title} · ${rows.length}${progress}`), ...(rich ? [""] : []), ...shown,
      ...(more > 0 ? [...(rich ? [""] : []), `…и ещё ${more}`] : []),
      ...(hint ? [...(rich ? [""] : []), hint] : [])]);
  };

  section("⚠️ Просрочено", overdue, (task) => item(task, ` — срок ${shortDate(dueDay(task, input.timezone)!)}`));
  section("Сегодня", todays, (task) => item(task));
  section("Ничьи", unowned, (task) => item(task, task.listName ? ` · ${cleanTaskTitle(task.listName, input.style)}` : "", false), UNOWNED_HINT,
    // Ничьё это то, что нужно разобрать, а не фон: полный десяток, а не пять строк и «ещё N».
    Math.max(perGroup, UNOWNED_SECTION_LIMIT));
  section("Ждут согласия", unaccepted, (task) => item(task, task.assignee ? ` — ${task.assignee}` : "", false));
  section("Разобрать", unsorted, (task) => item(task), UNSORTED_HINT);
  // Сфера жизни говорит о деле больше, чем имя списка, поэтому при метке заголовком становится
  // она. Список это группа дел по смыслу; одинаковое имя в разных областях это разные списки.
  const groups = new Map<string, BoardTask[]>();
  for (const task of rest) {
    // Проект называет раздел первым: сфера жизни говорит о деле, но имя проекта не должно из-за неё
    // пропадать. Источник отделяет одноимённые проекты разных областей, сфера идёт рядом в скобках.
    const sphere = task.lifeArea ? lifeAreaTitle(task.lifeArea) : null;
    const tags = task.listName
      ? [...(task.source === PERSONAL_SOURCE ? [] : [task.source]), ...(sphere ? [sphere] : [])]
      : [];
    const name = `${task.listName ?? sphere ?? NO_LIST}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`;
    groups.set(name, [...(groups.get(name) ?? []), task]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    (a.startsWith(NO_LIST) ? 1 : 0) - (b.startsWith(NO_LIST) ? 1 : 0) || a.localeCompare(b, "ru"));
  const stats = new Map((input.projects ?? []).map((project) => [project.id, project]));
  for (const [name, tasks] of ordered) {
    const project = tasks[0]?.projectId ? stats.get(tasks[0].projectId) : undefined;
    const progress = project && project.total >= PROGRESS_MIN_TOTAL && project.completed >= 1
      ? ` · сделано ${project.completed} из ${project.total}` : "";
    section(name, tasks, (task) => {
      const day = dueDay(task, input.timezone);
      return item(task, day ? ` — до ${shortDate(day)}` : "");
    }, undefined, perGroup, progress);
  }
  // Проект без открытого дела это не «пусто», а вопрос человеку: нет следующего шага или всё сделано.
  const projectLine = (project: BoardProject) => `${rich ? "-" : "•"} ${cleanTaskTitle(project.title, input.style)}`;
  const live = (input.projects ?? []).filter((project) => project.status === "accepted" && project.open === 0);
  const stalled = live.filter((project) => project.completed === 0);
  const finished = live.filter((project) => project.completed > 0);
  section("Проекты без шага", stalled, projectLine, NO_STEP_HINT);
  section("Проекты, где всё сделано", finished, projectLine, ALL_DONE_HINT);
  section("Жду ответа", waiting, (task) => item(task));
  section("Когда-нибудь", ideas, (task) => item(task));
  section("Традиции", rituals, (task) => item(task));

  if (sections.length === 0) return null;
  const footer = `Открытых дел: ${commitments.length}`;
  // Утренний обзор уходит одним сообщением Telegram: доска, не влезшая в предел, не доходит вовсе.
  // Поэтому лишние разделы отбрасываются с честным хвостом, а не рвутся посередине.
  const blocks = sections.map((lines) => lines.join("\n"));
  const kept: string[] = [];
  // Запас под хвост «…и ещё N разделов» и пустые строки между блоками.
  let length = footer.length + 60;
  for (const block of blocks) {
    if (length + block.length + 2 > TASK_BOARD_MAX_CHARACTERS && kept.length > 0) break;
    kept.push(block);
    length += block.length + 2;
  }
  const dropped = blocks.length - kept.length;
  return [
    ...kept,
    ...(dropped > 0 ? [`…и ещё ${dropped} ${dropped === 1 ? "раздел" : "раздела"}, спроси о них отдельно`] : []),
    footer,
  ].join("\n\n");
}

/**
 * Доска для ответа в чате: с жирными заголовками и директивой, которая не даёт автокату свернуть
 * её в «Полный ответ». Модель пересылает это поле как есть.
 */
export function taskBoardReply(
  tasks: readonly BoardTask[], now: Date, timezone: string, projects?: readonly BoardProject[],
): string | null {
  const board = formatTaskBoard({ now, style: "rich", tasks, timezone, ...(projects ? { projects } : {}) });
  return board === null ? null : `${TELEGRAM_KEEP_OPEN_DIRECTIVE}\n${board}`;
}
