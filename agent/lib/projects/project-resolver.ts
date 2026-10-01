/**
 * Проект области по имени: найти живой или завести новый.
 *
 * Exports:
 * - `ProjectArea`: где живёт проект (семья, группа, пространство, личный владелец).
 * - `findOrCreateProject`: имя из слов человека превращается в проект.
 *
 * Имя сравнивается только по тождеству: регистр, «ё», пробелы и разделитель « · » (SQL-функция
 * `task_project_key` из миграции 161, одна на базу и код). Какой из похожих проектов подходит по смыслу,
 * решает агент, видя список проектов области; код не склеивает «Дом» с «Квартирой».
 *
 * Параллельные записи одного имени сериализуются advisory-блокировкой на область и ключ имени, а
 * уникальный индекс `shared_tasks_active_project_title` остаётся последней преградой дубля.
 */
import type { PoolClient } from "pg";

import type { MemoryScope } from "./../memory-context.js";
import type { LifeArea } from "./../life-areas.js";

export interface ProjectArea {
  readonly familyId: string;
  readonly groupId: string | null;
  readonly scope: MemoryScope;
  readonly spaceId: string | null;
  /** Личный проект принадлежит одному человеку; у общей области владельца нет. */
  readonly ownerTelegramId: string | null;
}

const NO_UUID = "00000000-0000-0000-0000-000000000000";

export interface ResolvedProject {
  readonly id: string;
  /** Проект заведён этим вызовом, а не найден: от этого зависит, пишутся ли ему результат и сфера. */
  readonly created: boolean;
}

export async function resolveProject(
  client: PoolClient, area: ProjectArea, actorTelegramId: string, name: string,
  options: { lifeArea?: LifeArea | null; details?: string | null } = {},
): Promise<ResolvedProject> {
  const owner = area.scope === "personal" ? area.ownerTelegramId ?? actorTelegramId : "";
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [`project:${area.familyId}:${area.scope}:${area.groupId ?? NO_UUID}:${area.spaceId ?? NO_UUID}:${owner}:${name.trim().toLowerCase()}`],
  );
  const found = await client.query<{ id: string }>(
    `SELECT id FROM shared_tasks
      WHERE kind='project' AND status='accepted' AND family_id=$1 AND scope=$2
        AND group_id IS NOT DISTINCT FROM $3::uuid AND space_id IS NOT DISTINCT FROM $4::uuid
        AND ($2<>'personal' OR creator_telegram_id=$5)
        AND task_project_key(title)=task_project_key($6)`,
    [area.familyId, area.scope, area.groupId, area.spaceId, owner, name],
  );
  if (found.rows[0]) return { id: found.rows[0].id, created: false };
  const created = await client.query<{ id: string }>(
    `INSERT INTO shared_tasks(family_id,group_id,scope,creator_telegram_id,assignee_telegram_id,title,status,kind,space_id,life_area,details)
     VALUES($1,$2,$3,$4,$4,task_project_title($5),'accepted','project',$6,$7,$8) RETURNING id`,
    [area.familyId, area.groupId, area.scope, actorTelegramId, name, area.spaceId, options.lifeArea ?? null, options.details ?? null],
  );
  return { id: created.rows[0]!.id, created: true };
}

/** Идентификатор проекта для записи имени дела: сфера и результат нужны только новому проекту. */
export async function findOrCreateProject(
  client: PoolClient, area: ProjectArea, actorTelegramId: string, name: string, lifeArea?: LifeArea | null,
): Promise<string> {
  return (await resolveProject(client, area, actorTelegramId, name, { lifeArea })).id;
}
