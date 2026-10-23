/**
 * Утренний разбор семейных дел для семейной группы.
 *
 * Экспорт:
 * - `GroupOverviewTask`: общее дело семьи с именем того, кому оно поручено.
 * - `GroupOverview`: дела на момент утра и часовой пояс семьи.
 * - `formatGroupOverview`: текст разбора либо `null`, когда говорить не о чем.
 * - `claimableTasks`, `GROUP_OVERVIEW_CLAIM_BUTTONS`: ничьи дела под кнопки «Беру».
 *
 * Прод 29 сентября 2026: жена ведёт дела с ботом в семейной группе, а в личке почти не бывает, и всё,
 * что бот начинал сам, уходило только туда. Разбор собирается кодом, без модели, из одних общих дел
 * семьи (область `family`): личное в чат двоих не попадает. Молчание нормальный исход: день без
 * обязательств остаётся днём без сообщения, а идеи и традиции его не вызывают, как и в личном обзоре.
 */
import { cleanTaskTitle, dueDay, isOverdue, localDate, OPEN_TASK_STATUSES, shortDate, type BoardTask } from "../task-board.js";

export interface GroupOverviewTask extends BoardTask {
  /** Кому поручено дело; `null`, когда оно свободное. */
  readonly assigneeName: string | null;
  /** Id и версия: по ним под ничьим делом встаёт кнопка «Беру» (миграция 179). */
  readonly id?: string;
  readonly version?: number;
}

/** Больше пяти кнопок «Беру» под одним сообщением читаются как меню, а не как просьба разобрать. */
export const GROUP_OVERVIEW_CLAIM_BUTTONS = 5;

/** Ничьи дела, под которыми встанет «Беру»: свободные обязательства, в порядке доски. */
export function claimableTasks(overview: GroupOverview): Array<{ id: string; title: string; version: number }> {
  return overview.tasks
    .filter((task) => task.kind === "task" && task.status === "open" && task.id !== undefined && task.version !== undefined)
    .slice(0, GROUP_OVERVIEW_CLAIM_BUTTONS)
    .map((task) => ({ id: task.id!, title: task.title, version: task.version! }));
}

export interface GroupOverview {
  readonly now: Date;
  readonly tasks: readonly GroupOverviewTask[];
  readonly timezone: string;
}

const FIRST_TIME_EXPLANATION = [
  "Это общий утренний обзор семейных дел: раз в день, когда есть что делать.",
  "Владелец семьи может выключить его одной фразой боту в личном чате.",
].join(" ");

/** Строк в разделе: обзор читают за чаем всей семьёй, длинную простыню никто не дочитывал. */
const SECTION_ROWS = 5;
const PROJECT_STEPS = 5;

/**
 * Ревью 21 октября 2026 (пункт 8): прежний обзор был всей доской, с именем у каждой строки и просрочкой
 * при маме и ребёнке. Теперь «Сегодня» с именами, просроченное без имён и спокойно («с 18.10»), ничьи
 * под кнопками «Беру», по одному следующему шагу от проекта; остальное по кнопке «Все дела», которую
 * видит только нажавший. Подсказки «скажи…» нет: под сообщением кнопки.
 */
export function formatGroupOverview(
  overview: GroupOverview,
  options: { first?: boolean } = {},
): string | null {
  const commitments = overview.tasks.filter((task) => task.kind === "task" && OPEN_TASK_STATUSES.has(task.status));
  if (commitments.length === 0) return null;
  const today = localDate(overview.timezone, overview.now);
  const title = (task: GroupOverviewTask) => cleanTaskTitle(task.title, "plain");
  const named = (task: GroupOverviewTask) => `${task.assigneeName ? `${task.assigneeName}: ` : ""}${title(task)}`;
  const late = commitments.filter((task) => isOverdue(task, overview.now, today));
  const todays = commitments.filter((task) => !late.includes(task) && dueDay(task, overview.timezone) === today);
  const unowned = commitments.filter((task) => task.status === "open" && !late.includes(task) && !todays.includes(task));
  const shown = new Set([...late, ...todays, ...unowned]);
  const steps = new Map<string, GroupOverviewTask>();
  for (const task of commitments) {
    const project = task.listName;
    if (!project || shown.has(task) || task.status !== "accepted" || steps.has(project)) continue;
    steps.set(project, task);
  }
  const section = (heading: string, rows: readonly string[], total = rows.length) => rows.length === 0 ? [] : [[
    `${heading} · ${total > rows.length ? `${total} · показано ${rows.length}` : total}`,
    ...rows.map((row) => `• ${row}`),
  ].join("\n")];
  const blocks = [
    ...section("Сегодня", todays.slice(0, SECTION_ROWS).map(named), todays.length),
    ...section("⚠️ Просрочено", late.slice(0, SECTION_ROWS).map((task) => `${title(task)} — с ${shortDate(dueDay(task, overview.timezone)!)}`), late.length),
    ...section("Никто не взял", unowned.slice(0, SECTION_ROWS).map(title), unowned.length),
    ...section("Шаги проектов", [...steps].slice(0, PROJECT_STEPS).map(([project, task]) => `${cleanTaskTitle(project, "plain")}: ${named(task)}`), steps.size),
  ];
  return [
    "Доброе утро! Общие дела семьи на сегодня.",
    ...blocks,
    `Открытых · ${commitments.length}. Всё целиком по кнопке «Все дела», своё по «Мои дела».`,
    ...(options.first ? [FIRST_TIME_EXPLANATION] : []),
  ].join("\n\n");
}
