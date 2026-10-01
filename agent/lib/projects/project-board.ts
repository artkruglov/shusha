/**
 * Проекты области в виде, который нужен доске: прогресс и разделы «без шага» и «всё сделано».
 *
 * Exports:
 * - `loadBoardProjects`: живые проекты, видимые этому адресату; `undefined`, если прочитать не удалось.
 *
 * Сбой чтения проектов не должен отнимать у человека доску дел: без них она остаётся прежней, только
 * без прогресса. Поэтому ошибка пишется в лог и проглатывается здесь, а не наверху.
 */
import type { BoardProject } from "../task-board.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { projectRepository } from "./project-repository.js";

export async function loadBoardProjects(auth: MemoryAuthorization): Promise<BoardProject[] | undefined> {
  try {
    const { projects } = await projectRepository.execute(auth, { action: "list" });
    return (projects ?? []).map((project) => ({
      completed: project.completed, hasNextStep: project.hasNextStep, id: project.id, open: project.open,
      source: project.source, status: project.status, title: project.title, total: project.total,
    }));
  } catch (error) {
    console.error(JSON.stringify({ code: "AGENT_PROJECT_BOARD_UNAVAILABLE", error: error instanceof Error ? error.message.slice(0, 120) : "unknown" }));
    return undefined;
  }
}
