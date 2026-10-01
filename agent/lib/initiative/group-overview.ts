/**
 * Утренний разбор семейных дел для семейной группы.
 *
 * Экспорт:
 * - `GroupOverviewTask`: общее дело семьи с именем того, кому оно поручено.
 * - `GroupOverview`: дела на момент утра и часовой пояс семьи.
 * - `formatGroupOverview`: текст разбора либо `null`, когда говорить не о чем.
 *
 * Прод 29 сентября 2026: жена ведёт дела с ботом в семейной группе, а в личке почти не бывает, и всё,
 * что бот начинал сам, уходило только туда. Разбор собирается кодом, без модели, из одних общих дел
 * семьи (область `family`): личное в чат двоих не попадает. Молчание нормальный исход: день без
 * обязательств остаётся днём без сообщения, а идеи и традиции его не вызывают, как и в личном обзоре.
 */
import { formatTaskBoard, OPEN_TASK_STATUSES, type BoardTask } from "../task-board.js";

export interface GroupOverviewTask extends BoardTask {
  /** Кому поручено дело; `null`, когда оно свободное. */
  readonly assigneeName: string | null;
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

export function formatGroupOverview(
  overview: GroupOverview,
  options: { first?: boolean } = {},
): string | null {
  const commitments = overview.tasks.filter((task) => task.kind === "task" && OPEN_TASK_STATUSES.has(task.status));
  if (commitments.length === 0) return null;
  // Имя стоит в названии, потому что доска группирует по спискам, а в группе важнее «чьё».
  const tasks: BoardTask[] = overview.tasks.map((task) => ({
    ...task,
    title: task.assigneeName ? `${task.assigneeName}: ${task.title}` : task.title,
  }));
  const board = formatTaskBoard({ now: overview.now, style: "plain", tasks, timezone: overview.timezone });
  if (board === null) return null;
  return [
    "Доброе утро! Общие дела семьи на сегодня.",
    board,
    ...(options.first ? [FIRST_TIME_EXPLANATION] : []),
  ].join("\n\n");
}
