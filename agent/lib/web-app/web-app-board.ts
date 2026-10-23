/**
 * Доска дел для Mini App: те же разделы, что в чате, только данными, а не текстом.
 *
 * Exports:
 * - `WebAppBoard`, `WebAppSection`, `WebAppRow`: то, что получает страница.
 * - `webAppBoard`: разделы `taskBoardSections` в JSON.
 *
 * Разбор дел по разделам один на чат и приложение (`task-board.ts`), поэтому они не расходятся.
 * Страница показывает все строки раздела, а не пять, как чат. У строки список действий, которые к ней
 * подходят: «Сделано» и «Перенести» у моего принятого дела, «Беру» у ничьего, «Беру / Не могу» у поручения
 * мне и у дела, которое мне передают (`offered`). Это только какие кнопки рисовать; можно ли этому человеку, решает репозиторий дел при нажатии.
 * Id есть у каждой строки дела, даже без кнопок: по нему открывается карточка (`web-app-task-card.ts`).
 * `kind` раздела говорит странице, куда его положить: просрочено, сегодня, проекты, ничьи, жду ответа.
 */
import type { WebAppStaleTask } from "./web-app-stale.js";
import type { OverviewTask } from "../initiative/daily-overview.js";
import { taskBoardSections, cleanTaskTitle, type BoardSectionKind, type TaskBoardInput } from "../task-board.js";

/** What a row's buttons do; the API accepts only these (`web-app-api.ts`). */
export type WebAppAction = "accept" | "accept_transfer" | "claim" | "complete" | "decline" | "decline_transfer" | "postpone";

export interface WebAppRow {
  readonly actions: readonly WebAppAction[];
  readonly title: string;
  /** Срок, имя или пометка: «до 12.10», «ничьё»; пусто, если сказать нечего. */
  readonly detail: string;
  readonly id: string | null;
  readonly version: number | null;
  readonly repeat: boolean;
}

export interface WebAppSection {
  readonly kind: BoardSectionKind;
  readonly title: string;
  readonly rows: readonly WebAppRow[];
  readonly progress: { readonly completed: number; readonly total: number } | null;
  /** Проект раздела со счётом «сделано из всех»: линия прогресса на доске. */
  readonly project: { readonly completed: number; readonly id: string; readonly total: number } | null;
  readonly hint: string | null;
}

export interface WebAppBoard {
  readonly today: string;
  readonly open: number;
  readonly sections: readonly WebAppSection[];
  /** Tasks unchanged for two weeks (`web-app-stale.ts`): the home block «Давно без движения». */
  readonly stale?: readonly WebAppStaleTask[];
}

/**
 * Only actions that can work: an idea or a tradition is not completed, a proposed task is answered first
 * (`applyTaskStatus`), and the author's own request waits for the other person. A task with an exact time
 * or a repeat keeps its date: moving it is a conversation, not a tap. A child in an area may close their own
 * task but not edit it (`space-access.ts`), so `canMove` is false for them.
 */
function actionsOf(task: OverviewTask | null, waiting: ReadonlySet<string>, canMove: boolean): WebAppAction[] {
  if (task === null || task.kind !== "task" || typeof task.id !== "string" || typeof task.version !== "number") return [];
  const asked = waiting.has(task.id);
  if (task.status === "open") return ["claim", "complete"];
  if (task.status === "proposed") return asked ? [] : ["accept", "decline"];
  if (task.status !== "accepted" || asked) return [];
  const repeated = task.repeat !== undefined && task.repeat !== null;
  return canMove && task.dueAt === null && !repeated ? ["complete", "postpone"] : ["complete"];
}

export function webAppBoard(
  input: Omit<TaskBoardInput, "perGroup" | "style">, today: string, options: { canMove?: boolean } = {},
): WebAppBoard {
  const { commitments, sections } = taskBoardSections({ ...input, style: "plain" });
  const waiting = new Set((input.waiting ?? []).map((task) => (task as OverviewTask).id)
    .filter((id): id is string => typeof id === "string"));
  // A project has its own page here, so its section carries its own name, not the chat's «Ремонт (Семья)».
  const projectTitle = new Map((input.projects ?? []).map((project) => [project.id, project.title]));
  return {
    open: commitments,
    sections: sections.map((section) => ({
      hint: section.hint ?? null,
      kind: section.kind,
      progress: section.progress ?? null,
      project: section.project ?? null,
      rows: section.rows.map((row) => {
        const task = row.task as OverviewTask | null;
        // A handover is answered, not done: its status is the sender's «accepted», not the viewer's.
        const actions: WebAppAction[] = row.offered ? ["accept_transfer", "decline_transfer"] : actionsOf(task, waiting, options.canMove ?? true);
        const known = task !== null && typeof task.id === "string" && typeof task.version === "number";
        return {
          actions,
          // Разделитель хвоста нужен строке чата; у страницы хвост своей строкой под названием.
          detail: row.suffix.replace(/^\s*[—·]\s*/u, "").replace(/\s+—\s+/gu, " · "),
          id: known ? task.id! : null,
          repeat: task?.repeat !== undefined && task.repeat !== null,
          title: cleanTaskTitle(row.title, "plain"),
          version: known ? task.version! : null,
        };
      }),
      title: (section.kind === "project" && section.project ? projectTitle.get(section.project.id) : undefined) ?? section.title,
    })),
    today,
  };
}
