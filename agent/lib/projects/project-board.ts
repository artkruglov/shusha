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

/**
 * Старые дела несут неизменяемый `space_id`, новые нет, поэтому личный проект одного имени бывал дважды
 * (миграция 161 разбила их так, резолвер в legacy заводил двойника до миграции 178). Доска считает такую
 * пару одним проектом: иначе пустой двойник попадал в «Проекты без шага», а прогресс считался по половине
 * дел. Склеиваются копии одного scope (у групповых ещё и одного источника), id всех копий остаются в
 * `aliases`, чтобы дело любой из них нашло свой раздел.
 */
export function collapseBoardProjects(projects: readonly (BoardProject & { scope: string })[]): BoardProject[] {
  const merged = new Map<string, BoardProject & { scope: string }>();
  for (const project of projects) {
    // Одноимённые проекты двух разных групп остаются разными; личная пара копий одна (подписи источника у неё разные).
    const key = `${project.scope}\u0000${project.scope === "group" ? project.source : ""}\u0000${project.status}\u0000${project.title.trim().toLowerCase().replace(/ё/gu, "е").replace(/\s+/gu, " ")}`;
    const first = merged.get(key);
    merged.set(key, first === undefined ? { ...project, aliases: [] } : {
      ...first, aliases: [...(first.aliases ?? []), project.id], completed: first.completed + project.completed,
      hasNextStep: first.hasNextStep || project.hasNextStep, lifeArea: first.lifeArea ?? project.lifeArea ?? null,
      open: first.open + project.open, total: first.total + project.total,
    });
  }
  return [...merged.values()].map(({ scope: _scope, ...project }) => project);
}

export async function loadBoardProjects(
  auth: MemoryAuthorization, options: { withoutGroups?: boolean } = {},
): Promise<BoardProject[] | undefined> {
  try {
    const { projects } = await projectRepository.execute(auth, { action: "list" });
    // The Mini App shows no external group's data (`web-app/web-app-api.ts`), project titles included.
    const shown = (projects ?? []).filter((project) => !options.withoutGroups || project.scope !== "group");
    return collapseBoardProjects(shown.map((project) => ({
      completed: project.completed, hasNextStep: project.hasNextStep, id: project.id, lifeArea: project.lifeArea ?? null, open: project.open,
      scope: project.scope, source: project.source, status: project.status, title: project.title, total: project.total,
      version: project.version,
    })));
  } catch (error) {
    console.error(JSON.stringify({ code: "AGENT_PROJECT_BOARD_UNAVAILABLE", error: error instanceof Error ? error.message.slice(0, 120) : "unknown" }));
    return undefined;
  }
}
