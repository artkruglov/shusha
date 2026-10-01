/**
 * Переносы дел между проектами: отмена проекта и слияние.
 *
 * Exports:
 * - `cancelProject`: проект отменяется, его открытые дела отвязываются и живут сами по себе.
 * - `mergeProjects`: дела проекта переходят в другой проект той же области, исходный отменяется.
 *
 * Ссылка на проект это метка организации, а не содержимое дела, поэтому перенос не спрашивает право
 * на правку каждого дела отдельно: достаточно права на оба проекта. Каждое перенесённое дело получает
 * строку версии, чтобы историю было видно, а триггер `guard_shared_task_project` не даёт унести дело в
 * проект чужой области. Согласие второго человека на общий проект берёт агент до вызова.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import type { MemoryAuthorization, MemoryScope } from "../memory-context.js";
import { denied, readProjects, type TaskRow } from "../shared-task-access.js";
import { recordTaskVersion } from "../shared-task-handover.js";
import { requireTaskRecordAction } from "../spaces/task-space-action.js";

const MOVED_STATUSES = "('open','proposed','accepted')";

async function snapshotChildren(client: PoolClient, projectId: string, actor: string, action: string, onlyOpen: boolean) {
  await client.query(
    `INSERT INTO shared_task_versions(task_id,version,actor_telegram_id,action,previous_record)
     SELECT id, version+1, $2, $3, to_jsonb(t) FROM shared_tasks t
      WHERE project_id=$1 ${onlyOpen ? `AND status IN ${MOVED_STATUSES}` : ""}
     ON CONFLICT (task_id,version) DO NOTHING`, [projectId, actor, action]);
}

export async function cancelProject(client: PoolClient, project: TaskRow, actor: string): Promise<string[]> {
  const { rows } = await client.query<{ title: string }>(
    `SELECT title FROM shared_tasks WHERE project_id=$1 AND status IN ${MOVED_STATUSES} ORDER BY created_at, id`, [project.id]);
  await snapshotChildren(client, project.id, actor, "project_detach", true);
  await client.query(
    `UPDATE shared_tasks SET project_id=NULL, list_name=NULL, version=version+1, updated_at=now()
      WHERE project_id=$1 AND status IN ${MOVED_STATUSES}`, [project.id]);
  await recordTaskVersion(client, project, "project_cancel", actor);
  await client.query("UPDATE shared_tasks SET status='cancelled',version=version+1,updated_at=now() WHERE id=$1", [project.id]);
  return rows.map((row) => row.title);
}

/** Возвращает название проекта, в который влили дела. */
export async function mergeProjects(
  client: PoolClient, auth: MemoryAuthorization, scope: MemoryScope, source: TaskRow, intoId: string, actor: string,
): Promise<string> {
  const [target] = await readProjects(client, auth, scope, { id: intoId });
  if (!target) denied();
  await requireTaskRecordAction(client, auth, intoId, "write");
  const locked = (await client.query<TaskRow>("SELECT * FROM shared_tasks WHERE id=$1 AND kind='project' FOR UPDATE", [intoId])).rows[0];
  if (!locked || locked.status !== "accepted") denied();
  if (locked.scope !== source.scope || locked.group_id !== source.group_id || locked.space_id !== source.space_id) {
    throw new AppError("AGENT_PROJECT_SCOPE_MISMATCH", "Проекты из разных областей слить нельзя");
  }
  await snapshotChildren(client, source.id, actor, "project_merge", false);
  await client.query(
    `UPDATE shared_tasks SET project_id=$2, list_name=$3, version=version+1, updated_at=now() WHERE project_id=$1`,
    [source.id, intoId, target.listName]);
  await recordTaskVersion(client, source, "project_merge", actor);
  await client.query(
    `UPDATE shared_tasks SET status='cancelled', details=left(concat_ws(E'\\n', details, $2::text), 1000),
       version=version+1, updated_at=now() WHERE id=$1`,
    [source.id, `Объединён с проектом «${target.listName}»`]);
  return target.listName;
}
