/**
 * Переносы дел между проектами: отмена проекта и слияние.
 *
 * Exports:
 * - `cancelProject`: проект отменяется, его открытые дела отвязываются и живут сами по себе.
 * - `mergeProjects`: дела проекта переходят в другой проект той же области, исходный отменяется;
 *   личный двойник без области (legacy) вливается в проект автора с его личной областью.
 * - `reviveTaskProject`: дело, возвращённое в работу, не остаётся в закрытом проекте.
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

/** Область проекта это личная область его автора в семье, ещё живущей по-старому (legacy). */
async function isAuthorPersonalSpace(client: PoolClient, project: TaskRow): Promise<boolean> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM spaces s JOIN users owner ON owner.id=s.owner_user_id
       JOIN family_space_runtime runtime ON runtime.family_id=s.family_id AND runtime.mode='legacy'
      WHERE s.id=$1 AND s.family_id=$2 AND s.kind='personal' AND owner.telegram_user_id=$3`,
    [project.space_id, project.family_id, project.creator_telegram_id]);
  return rowCount === 1;
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
  // Личная пара одного автора, разделённая только технической областью (legacy, миграция 178):
  // дела без области переходят в личную область автора вместе с проектом.
  const legacyPersonalTwin = locked.space_id !== source.space_id && source.space_id === null &&
    locked.scope === "personal" && source.scope === "personal" && locked.group_id === null && source.group_id === null &&
    locked.creator_telegram_id === source.creator_telegram_id && await isAuthorPersonalSpace(client, locked);
  if (locked.scope !== source.scope || locked.group_id !== source.group_id ||
    (locked.space_id !== source.space_id && !legacyPersonalTwin)) {
    throw new AppError("AGENT_PROJECT_SCOPE_MISMATCH", "Проекты из разных областей (личный и общий, разные чаты) слить нельзя. Оставь оба или переноси дела по одному через update с listName");
  }
  await snapshotChildren(client, source.id, actor, "project_merge", false);
  await client.query(
    `UPDATE shared_tasks SET project_id=$2, list_name=$3, space_id=$4, version=version+1, updated_at=now() WHERE project_id=$1`,
    [source.id, intoId, target.listName, locked.space_id]);
  await recordTaskVersion(client, source, "project_merge", actor);
  await client.query(
    `UPDATE shared_tasks SET status='cancelled', details=left(concat_ws(E'\\n', details, $2::text), 1000),
       version=version+1, updated_at=now() WHERE id=$1`,
    [source.id, `Объединён с проектом «${target.listName}»`]);
  return target.listName;
}

/**
 * Закрытый проект скрыт из активных, и открытое дело в нём пропало бы с доски (замечание Codex,
 * 16 октября 2026: закрыть последнее дело, закрыть проект, вернуть дело). Сделанный проект поэтому
 * открывается вместе с делом, а если в той же области уже живёт проект того же имени, дело переходит
 * в него: два живых проекта одного имени запрещает индекс. Отменённый проект человек бросил сам, и
 * дело выходит из него, как открытые дела при отмене. Вызывается под блокировкой дела, после смены
 * статуса, в той же транзакции; строку версии дела уже записал переход.
 */
export async function reviveTaskProject(client: PoolClient, task: TaskRow, actor: string): Promise<void> {
  if (!task.project_id) return;
  const project = (await client.query<TaskRow>(
    "SELECT * FROM shared_tasks WHERE id=$1 AND kind='project' FOR UPDATE", [task.project_id])).rows[0];
  if (!project || project.status === "accepted") return;
  if (project.status !== "completed") {
    await client.query("UPDATE shared_tasks SET project_id=NULL, list_name=NULL WHERE id=$1", [task.id]);
    return;
  }
  const live = (await client.query<{ id: string; title: string }>(
    `SELECT id, title FROM shared_tasks
      WHERE kind='project' AND status='accepted' AND family_id=$1 AND scope=$2 AND id<>$3
        AND group_id IS NOT DISTINCT FROM $4::uuid AND space_id IS NOT DISTINCT FROM $5::uuid
        AND ($2<>'personal' OR creator_telegram_id=$6) AND task_project_key(title)=task_project_key($7)
      LIMIT 1 FOR UPDATE`,
    [project.family_id, project.scope, project.id, project.group_id, project.space_id, project.creator_telegram_id, project.title])).rows[0];
  if (live) {
    await client.query("UPDATE shared_tasks SET project_id=$2, list_name=$3 WHERE id=$1", [task.id, live.id, live.title]);
    return;
  }
  await recordTaskVersion(client, project, "project_reopen", actor);
  await client.query("UPDATE shared_tasks SET status='accepted',version=version+1,updated_at=now() WHERE id=$1", [project.id]);
}
