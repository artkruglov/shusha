/**
 * Доска дел: весь открытый список перед глазами, оформленный кодом, а не моделью.
 *
 * Exports:
 * - `BoardTask`: поля строки списка, которых хватает для доски.
 * - `formatTaskBoard`: текст доски или `null`, когда показывать нечего.
 * - `taskBoardSections`, `BoardSection`, `BoardRow`: те же разделы без текста, для Mini App.
 * - `closedTaskBoardReply`, `closedTaskBoard`: доска закрытого (`view: done`): сделанное и отменённое.
 * - `isStale`, `STALE_TASK_DAYS`: дело, которое давно не двигалось.
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
  /** День последнего изменения (UTC): по нему видно, что дело давно не двигалось. */
  readonly updatedOn?: string | null;
}

/** Проект области со счётом дел: прогресс в заголовке раздела и разделы без шага и «всё сделано». */
export interface BoardProject {
  /** Id всех физических копий проекта, склеенных в этот (`collapseBoardProjects`); дело находит его по любому. */
  readonly aliases?: readonly string[];
  readonly completed: number;
  readonly hasNextStep: boolean;
  readonly id: string;
  /** Сфера проекта: подпись раздела, а не ключ, поэтому дела с разными сферами остаются в одном разделе. */
  readonly lifeArea?: LifeArea | null;
  readonly open: number;
  readonly source: string;
  readonly status: string;
  readonly title: string;
  readonly total: number;
  /** Версия проекта: по ней встаёт кнопка «Завершить» (миграция 193). */
  readonly version?: number;
}

export interface TaskBoardInput {
  /** Открытые дела, идеи и традиции человека. */
  readonly tasks: readonly BoardTask[];
  /** Его просьбы другим, на которые ещё не ответили. */
  readonly waiting?: readonly BoardTask[];
  /**
   * Дела, которые ему передают (`shared-task-handover.ts`): до его «беру» их ведёт прежний исполнитель, поэтому
   * в `tasks` их нет, а на доске они стоят в «Ждут согласия», как поручение.
   */
  readonly offered?: readonly BoardTask[];
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

/** Сколько дней дело может стоять без изменений, прежде чем доска и сводка назовут его давним. */
export const STALE_TASK_DAYS = 14;

/** Принятое своё дело, которое не менялось две недели: о нём не напоминают, а помогают решить. */
export function isStale(task: BoardTask, today: string): boolean {
  if (task.kind !== "task" || task.status !== "accepted" || !task.updatedOn) return false;
  const days = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${task.updatedOn}T00:00:00Z`)) / 86_400_000;
  return days >= STALE_TASK_DAYS;
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
  // По кодовым точкам: половина суррогатной пары ломала эмодзи и могла уронить всё сообщение.
  const points = Array.from(title.replace(/\s+/gu, " ").trim());
  const short = points.length > TASK_BOARD_MAX_TITLE ? `${points.slice(0, TASK_BOARD_MAX_TITLE - 1).join("")}…` : points.join("");
  return style === "rich" ? short.replace(/[\\*_`~|[\]()<>=]/gu, "\\$&") : short;
}

/** Имя человек пишет сам: в rich-стиле оно экранируется так же, как название дела. */
function note(task: BoardTask, style: TaskBoardInput["style"]): string {
  if (task.status === "open") return " · ничьё";
  if (task.status === "proposed") return task.assignee ? ` · ждёт согласия: ${cleanTaskTitle(task.assignee, style)}` : " · ждёт согласия";
  return "";
}

/** Одна строка раздела: дело (или проект без шага) и хвост после названия. */
export interface BoardRow {
  /** Дело строки; у проекта без шага и проекта, где всё сделано, его нет. */
  readonly task: BoardTask | null;
  readonly title: string;
  /** Срок, имя или пометка после названия, с разделителем: « — до 12.10», « · ничьё». */
  readonly suffix: string;
  /** Проект строки «Проекты без шага» и «где всё сделано». */
  readonly project?: BoardProject;
  /** Дело из `offered`: его принимают или отклоняют, а не закрывают, хотя по статусу оно принятое. */
  readonly offered?: boolean;
}

/** Что это за раздел: чат печатает заголовок, Mini App раскладывает разделы по своим местам. */
export type BoardSectionKind = "finished" | "ideas" | "overdue" | "project" | "rituals" | "stalled" | "today"
  | "unaccepted" | "unowned" | "unsorted" | "waiting";

export interface BoardSection {
  readonly kind: BoardSectionKind;
  readonly title: string;
  readonly rows: readonly BoardRow[];
  /** Сколько строк показывать в чате; остальное уходит в «…и ещё N». */
  readonly limit: number;
  readonly progress?: { readonly completed: number; readonly total: number };
  /** Имя проекта или списка без подписей области: одноимённые разделы разных областей чат сливает. */
  readonly group?: string;
  /** Проект раздела со своим счётом, даже когда заголовок чата прогресса не пишет. */
  readonly project?: { readonly completed: number; readonly id: string; readonly total: number };
  readonly hint?: string;
}

/**
 * Разделы доски по порядку, без текста: чат печатает их строками (`formatTaskBoard`), а Mini App
 * рисует карточками (`task-board-model.ts`), и разбор дел по разделам у них один.
 */
export function taskBoardSections(input: TaskBoardInput): { commitments: number; sections: BoardSection[] } {
  const perGroup = input.perGroup ?? 5;
  const today = localDate(input.timezone, input.now);

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
  const offered = (input.offered ?? []).filter((task) => OPEN_TASK_STATUSES.has(task.status));

  const sections: BoardSection[] = [];
  const row = (task: BoardTask, suffix = "", withNote = true): BoardRow =>
    ({ suffix: `${suffix}${withNote ? note(task, input.style) : ""}`, task, title: task.title });
  const section = <Row>(kind: BoardSectionKind, title: string, rows: readonly Row[], line: (row: Row) => BoardRow,
    hint?: string, limit = perGroup, progress?: BoardSection["progress"], project?: BoardSection["project"], group?: string) => {
    if (rows.length === 0) return;
    sections.push({ kind, limit, rows: rows.map(line), title, ...(hint ? { hint } : {}), ...(progress ? { progress } : {}),
      ...(project ? { project } : {}), ...(group ? { group } : {}) });
  };

  section("overdue", "⚠️ Просрочено", overdue, (task) => row(task, ` — срок ${shortDate(dueDay(task, input.timezone)!)}`));
  section("today", "Сегодня", todays, (task) => row(task));
  section("unowned", "Ничьи", unowned, (task) => row(task, task.listName ? ` · ${cleanTaskTitle(task.listName, input.style)}` : "", false), UNOWNED_HINT,
    // Ничьё это то, что нужно разобрать, а не фон: полный десяток, а не пять строк и «ещё N».
    Math.max(perGroup, UNOWNED_SECTION_LIMIT));
  // A handover waits for the same yes as a request: the row names who hands it over (its current assignee).
  const handover = (task: BoardTask): BoardRow =>
    ({ offered: true, suffix: task.assignee ? ` — передаёт: ${cleanTaskTitle(task.assignee, input.style)}` : " — передают", task, title: task.title });
  section("unaccepted", "Ждут согласия", [
    ...unaccepted.map((task) => row(task, task.assignee ? ` — ${cleanTaskTitle(task.assignee, input.style)}` : "", false)),
    ...offered.map(handover),
  ], (line) => line);
  section("unsorted", "Разобрать", unsorted, (task) => row(task), UNSORTED_HINT);
  // Раздел это проект: один на проект, как бы ни различались сферы его дел (прод 15 октября 2026:
  // «Даня · Учёба» трижды с одним «сделано 5 из 9»). Источник отделяет одноимённые проекты разных
  // областей, сфера проекта идёт рядом в скобках. Дело без известного проекта группируется по имени
  // списка или своей сфере, как раньше.
  const byId = new Map<string, BoardProject>();
  for (const project of input.projects ?? []) {
    for (const id of [project.id, ...(project.aliases ?? [])]) byId.set(id, project);
  }
  const label = (title: string, tags: readonly (string | null)[]) => {
    const shown = tags.filter((tag): tag is string => tag !== null);
    return `${title}${shown.length > 0 ? ` (${shown.join(", ")})` : ""}`;
  };
  const groups = new Map<string, { base: string; name: string; project?: BoardProject; tasks: BoardTask[] }>();
  for (const task of rest) {
    const project = task.projectId ? byId.get(task.projectId) : undefined;
    const sphere = task.lifeArea ? lifeAreaTitle(task.lifeArea) : null;
    const key = project ? `project:${project.id}` : `list:${task.listName ?? ""}\u0000${task.source}\u0000${sphere ?? ""}`;
    const name = project
      ? project.title
      : task.listName
        ? label(task.listName, [task.source === PERSONAL_SOURCE ? null : task.source, sphere])
        : sphere ?? NO_LIST;
    const base = project ? project.title : task.listName ?? sphere ?? NO_LIST;
    const group = groups.get(key) ?? { base, name, ...(project ? { project } : {}), tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  // Сфера проекта, а если её нет, общая сфера всех его дел; разные сферы дел заголовок не делят.
  for (const group of groups.values()) {
    const project = group.project;
    if (!project) continue;
    const spheres = new Set(group.tasks.map((task) => task.lifeArea ?? null));
    const shared = spheres.size === 1 ? [...spheres][0] : null;
    const sphere = project.lifeArea ?? shared ?? null;
    group.name = label(project.title, [project.source === PERSONAL_SOURCE ? null : project.source,
      sphere ? lifeAreaTitle(sphere) : null]);
  }
  const ordered = [...groups.values()].sort((a, b) =>
    (a.name.startsWith(NO_LIST) ? 1 : 0) - (b.name.startsWith(NO_LIST) ? 1 : 0) || a.name.localeCompare(b.name, "ru"));
  for (const { base, name, project, tasks } of ordered) {
    const progress = project && project.total >= PROGRESS_MIN_TOTAL && project.completed >= 1
      ? { completed: project.completed, total: project.total } : undefined;
    section("project", name, tasks, (task) => {
      const day = dueDay(task, input.timezone);
      return row(task, day ? ` — до ${shortDate(day)}` : "");
    }, undefined, perGroup, progress,
    project ? { completed: project.completed, id: project.id, total: project.total } : undefined, base);
  }
  // Проект без открытого дела это не «пусто», а вопрос человеку: нет следующего шага или всё сделано.
  const projectRow = (project: BoardProject): BoardRow => ({ project, suffix: "", task: null, title: project.title });
  const live = (input.projects ?? []).filter((project) => project.status === "accepted" && project.open === 0);
  const stalled = live.filter((project) => project.completed === 0);
  const finished = live.filter((project) => project.completed > 0);
  section("stalled", "Проекты без шага", stalled, projectRow, NO_STEP_HINT);
  section("finished", "Проекты, где всё сделано", finished, projectRow, ALL_DONE_HINT);
  section("waiting", "Жду ответа", waiting, (task) => row(task));
  section("ideas", "Когда-нибудь", ideas, (task) => row(task));
  section("rituals", "Традиции", rituals, (task) => row(task));
  return { commitments: commitments.length, sections };
}

export function formatTaskBoard(input: TaskBoardInput): string | null {
  const heading = (text: string) => input.style === "rich" ? `**${text}**` : text;
  // Ответ модели уходит как Telegram Rich Markdown, где одиночный перевод строки это пробел:
  // строки секции склеивались в абзац. В разметке каждая строка обязана быть своим блоком,
  // поэтому там настоящий список `-` и пустая строка после заголовка. Служебное сообщение
  // (утренний обзор) уходит без разметки, и ему нужен ровно обратный, дословный вид.
  const rich = input.style === "rich";
  const { commitments, sections } = taskBoardSections(input);
  if (sections.length === 0) return null;
  /** Имя и счёт каждого раздела: не влезший раздел называется в хвосте, а не теряется безымянным. */
  const sectionNames = sections.map(({ rows, title }) => `${title} · ${rows.length}`);
  const blocks = sections.map(({ hint, limit, progress, rows, title }) => {
    const shown = rows.slice(0, limit).map((row) => `${rich ? "-" : "•"} ${cleanTaskTitle(row.title, input.style)}${row.suffix}`);
    const more = rows.length - shown.length;
    const done = progress ? ` · сделано ${progress.completed} из ${progress.total}` : "";
    // Хвост «…и ещё N» и подсказка это отдельные абзацы: без пустой строки разметка считает их
    // продолжением последнего пункта списка и печатает внутри пункта.
    return [heading(`${title} · ${rows.length}${done}`), ...(rich ? [""] : []), ...shown,
      ...(more > 0 ? [...(rich ? [""] : []), `…и ещё ${more}`] : []),
      ...(hint ? [...(rich ? [""] : []), hint] : [])].join("\n");
  });
  const footer = `Открытых дел: ${commitments}`;
  // Утренний обзор уходит одним сообщением Telegram: доска, не влезшая в предел, не доходит вовсе.
  // Поэтому лишние разделы отбрасываются, а не рвутся посередине, и хвост называет каждый из них:
  // безымянное «…и ещё 3 раздела» не говорило, о чём спросить (замечание Codex, 16 октября 2026).
  const total = (kept: number) => blocks.slice(0, kept).reduce((sum, block) => sum + block.length + 2, 0)
    + footer.length + (kept < blocks.length ? droppedTail(sectionNames.slice(kept), input.style).length + 2 : 0);
  let kept = blocks.length;
  while (kept > 1 && total(kept) > TASK_BOARD_MAX_CHARACTERS) kept -= 1;
  return [
    ...blocks.slice(0, kept),
    ...(kept < blocks.length ? [droppedTail(sectionNames.slice(kept), input.style)] : []),
    footer,
  ].join("\n\n");
}

const DROPPED_NAMES_MAX = 8;

function droppedTail(names: readonly string[], style: TaskBoardInput["style"]): string {
  const shown = names.slice(0, DROPPED_NAMES_MAX).map((name) => cleanTaskTitle(name, style));
  const more = names.length - shown.length;
  return `Не поместились: ${shown.join("; ")}${more > 0 ? ` и ещё ${more}` : ""}. Спроси о любом отдельно.`;
}

const CLOSED_SECTION_LIMIT = 15;
const CLOSED_SECTIONS: readonly { readonly statuses: readonly string[]; readonly title: string }[] = [
  { statuses: ["completed"], title: "Сделано" },
  { statuses: ["cancelled", "declined"], title: "Отменено" },
];

/**
 * Закрытое тоже доска, но своя: открытая доска отбрасывает закрытые строки и на `view: done` давала
 * пустоту или чужие разделы проектов «без шага» (замечание Codex, 16 октября 2026). Строки идут в
 * порядке списка, свежие первыми.
 */
export function closedTaskBoardReply(tasks: readonly BoardTask[]): string | null {
  const board = closedTaskBoard(tasks, "rich");
  return board === null ? null : `${TELEGRAM_KEEP_OPEN_DIRECTIVE}\n${board}`;
}

/** Закрытое без директивы; простой вид нужен ответу, удержанному до конца хода (`telegram-turn-board.ts`). */
export function closedTaskBoard(tasks: readonly BoardTask[], style: TaskBoardInput["style"]): string | null {
  const rich = style === "rich";
  const sections = CLOSED_SECTIONS.flatMap(({ statuses, title }) => {
    const rows = tasks.filter((task) => statuses.includes(task.status));
    if (rows.length === 0) return [];
    const bullet = rich ? "-" : "•";
    const shown = rows.slice(0, CLOSED_SECTION_LIMIT).map((task) => `${bullet} ${cleanTaskTitle(task.title, style)}`);
    const more = rows.length - shown.length;
    const heading = rich ? `**${title} · ${rows.length}**` : `${title} · ${rows.length}`;
    return [[heading, ...(rich ? [""] : []), ...shown, ...(more > 0 ? [`${bullet} …и ещё ${more}`] : [])].join("\n")];
  });
  return sections.length === 0 ? null : sections.join("\n\n");
}
