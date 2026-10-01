/**
 * Проекты области: чтение и переходы состояния.
 *
 * Exports:
 * - `projectRepository`: list, create, update, complete, cancel, reopen, merge.
 *
 * Проект это запись `shared_tasks` с `kind='project'` (миграция 161), поэтому права, области и версии
 * те же, что у дел: личный проект видит и правит только его автор, общий видит и правит любой читатель
 * области. Требование «сначала спросить второго человека» живёт в правиле для агента, а не в базе:
 * оно смысловое. Закрыть проект с открытыми делами нельзя, отмена отвязывает их, а не удаляет.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { MemoryAuthorization, MemoryScope } from "../memory-context.js";
import { authorize, denied, readProjects, type ProjectListing, type TaskRow } from "../shared-task-access.js";
import { createTask } from "../shared-task-create.js";
import { recordTaskVersion } from "../shared-task-handover.js";
import { requireWriteSpace } from "../spaces/space-write.js";
import { requireTaskRecordAction } from "../spaces/task-space-action.js";
import { projectInput, type ProjectInput } from "./project-contract.js";
import { mergeProjects, cancelProject } from "./project-moves.js";
import { resolveProject } from "./project-resolver.js";

const DUPLICATE = "shared_tasks_active_project_title";

function duplicate(error: unknown): never {
  if (error instanceof Error && error.message.includes(DUPLICATE)) {
    throw new AppError("AGENT_PROJECT_DUPLICATE", "Живой проект с таким названием уже есть: объедините их или назовите иначе");
  }
  throw error;
}

function present(row: ProjectListing) {
  return {
    completed: row.completedItemCount, details: row.details, hasNextStep: row.unfinishedItemCount > 0,
    id: row.projectId, lifeArea: row.lifeArea, open: row.unfinishedItemCount, source: row.source,
    status: row.status, title: row.listName, total: row.itemCount, version: row.version,
  };
}

export type ProjectView = ReturnType<typeof present>;

/** Проект, который человек видит, заблокированный на изменение; версия из чтения должна совпасть. */
async function lockVisible(
  client: PoolClient, auth: MemoryAuthorization, scope: MemoryScope, id: string, version: number,
): Promise<TaskRow> {
  const [visible] = await readProjects(client, auth, scope, { id, includeClosed: true });
  if (!visible) denied();
  await requireTaskRecordAction(client, auth, id, "write");
  const locked = (await client.query<TaskRow>(
    "SELECT *, due_on::text FROM shared_tasks WHERE id=$1 AND kind='project' FOR UPDATE", [id])).rows[0];
  if (!locked) denied();
  if (locked.version !== version) {
    throw new AppError("AGENT_PROJECT_VERSION_CONFLICT", "Проект уже изменился. Прочитайте его заново (list)");
  }
  return locked;
}

async function openTitles(client: PoolClient, projectId: string): Promise<string[]> {
  const { rows } = await client.query<{ title: string }>(
    `SELECT title FROM shared_tasks WHERE project_id=$1 AND status IN ('open','proposed','accepted')
      ORDER BY created_at, id LIMIT 5`, [projectId]);
  return rows.map((row) => row.title);
}

export const projectRepository = {
  async execute(auth: MemoryAuthorization, raw: ProjectInput) {
    const parsed = projectInput.safeParse(raw);
    if (!parsed.success) throw new AppError("AGENT_PROJECT_INPUT_INVALID", "Проверьте действие и поля проекта");
    const input = parsed.data;
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const scope = await authorize(client, auth);
      const actor = auth.telegramUserId!;

      if (input.action === "list") {
        const rows = await readProjects(client, auth, scope, { includeClosed: input.includeClosed ?? false });
        await client.query("COMMIT");
        return { projects: rows.map(present) };
      }

      const spaceId = await requireWriteSpace(client, {
        chatType: auth.groupId === null ? "private" : "supergroup", familyId: auth.familyId, groupId: auth.groupId,
        ...(auth.space ? { space: auth.space } : {}), userId: auth.userId,
      });
      const groupId = scope === "group" ? auth.groupId : null;

      if (input.action === "create") {
        const area = { familyId: auth.familyId, groupId, scope, spaceId, ownerTelegramId: actor };
        const project = await resolveProject(client, area, actor, input.title!,
          { details: input.details ?? null, lifeArea: input.lifeArea ?? null }).catch(duplicate);
        let nextStep: { id: string; title: string } | null = null;
        if (input.nextStep) {
          // Первое действие входит в проект по его названию тем же путём, что и любое дело.
          const id = await createTask(client, auth, scope, spaceId, {
            action: "create", dueOn: input.nextStep.dueOn, listName: input.title!, title: input.nextStep.title,
          } as never);
          nextStep = { id, title: input.nextStep.title };
        }
        const [view] = await readProjects(client, auth, scope, { id: project.id });
        await client.query("COMMIT");
        return { created: project.created, nextStep, project: view ? present(view) : null };
      }

      const locked = await lockVisible(client, auth, scope, input.id!, input.version!);
      let detached: string[] = [];
      let mergedInto: string | null = null;

      if (input.action === "update") {
        await recordTaskVersion(client, locked, "project_update", actor);
        await client.query(
          `UPDATE shared_tasks SET title=COALESCE(task_project_title($2),title), details=$3, life_area=$4,
             version=version+1, updated_at=now() WHERE id=$1`,
          [locked.id, input.title ?? null,
            input.details === undefined ? locked.details : input.details,
            input.lifeArea === undefined ? locked.life_area : input.lifeArea]).catch(duplicate);
      } else if (input.action === "complete") {
        if (locked.status !== "accepted") denied();
        const open = await openTitles(client, locked.id);
        if (open.length > 0) {
          throw new AppError("AGENT_PROJECT_HAS_OPEN_TASKS",
            `В проекте есть открытые дела: ${open.map((title) => `«${title}»`).join(", ")}. Закройте их или отмените проект`);
        }
        await recordTaskVersion(client, locked, "project_complete", actor);
        await client.query("UPDATE shared_tasks SET status='completed',version=version+1,updated_at=now() WHERE id=$1", [locked.id]);
      } else if (input.action === "cancel") {
        if (locked.status !== "accepted") denied();
        detached = await cancelProject(client, locked, actor);
      } else if (input.action === "reopen") {
        if (locked.status === "accepted") denied();
        await recordTaskVersion(client, locked, "project_reopen", actor);
        await client.query("UPDATE shared_tasks SET status='accepted',version=version+1,updated_at=now() WHERE id=$1", [locked.id]).catch(duplicate);
      } else {
        if (locked.status !== "accepted") denied();
        mergedInto = await mergeProjects(client, auth, scope, locked, input.intoId!, actor);
      }

      const [view] = await readProjects(client, auth, scope, { id: input.id!, includeClosed: true });
      await client.query("COMMIT");
      return { detachedTasks: detached, mergedInto, project: view ? present(view) : null };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
