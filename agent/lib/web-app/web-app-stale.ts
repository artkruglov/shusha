/**
 * Tasks that have not moved for two weeks, as the Mini App lists them (docs/design/task-lists-v3.ru.md).
 *
 * Exports:
 * - `WebAppStaleTask`, `staleTasksOf`: the list, oldest first, without the tasks the person left alone.
 * - `staleOfOverview`: the same from an already read board, with the person's rests read once.
 *
 * Kept apart from `web-app-api.ts`, which carries it on the board answer, and from `web-app-stale-api.ts`,
 * which answers the review screen: the home screen gets the count without a request of its own (the edge
 * limits `/app-api/` per client).
 */
import { overviewRestRepository } from "../initiative/overview-rest-repository.js";
import { isStale, OPEN_TASK_STATUSES, type BoardTask } from "../task-board.js";

export interface WebAppStaleTask {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  /** The day it last changed, YYYY-MM-DD: «не менялось с 15 сентября». */
  readonly since: string;
  readonly project: string | null;
}

type ListedTask = BoardTask & { readonly id?: string; readonly version?: number };

/** Oldest first: the task that waited longest is the first card. */
export function staleTasksOf(tasks: readonly ListedTask[], today: string, rested: ReadonlySet<string>): WebAppStaleTask[] {
  return tasks
    .filter((task) => OPEN_TASK_STATUSES.has(task.status) && isStale(task, today) && typeof task.id === "string"
      && typeof task.version === "number" && !rested.has(task.id))
    .map((task) => ({ id: task.id!, project: task.listName, since: task.updatedOn!, title: task.title, version: task.version! }))
    .sort((left, right) => left.since.localeCompare(right.since) || left.id.localeCompare(right.id));
}

export async function staleOfOverview(userId: string, tasks: readonly ListedTask[], today: string): Promise<WebAppStaleTask[]> {
  const candidates = tasks.filter((task) => isStale(task, today));
  const versioned = candidates.flatMap((task) => typeof task.id === "string" && typeof task.version === "number"
    ? [{ id: task.id, version: task.version }] : []);
  const { rested } = await overviewRestRepository.read(userId, versioned);
  return staleTasksOf(candidates, today, rested);
}
