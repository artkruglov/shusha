/**
 * Проект области по имени: найти живой или завести новый.
 *
 * Exports:
 * - `ProjectArea`: где живёт проект (семья, группа, пространство, личный владелец).
 * - `resolveProject`: найти живой проект или завести новый (`manage_projects` create).
 * - `findNamedProject`: живой проект области по имени из `listName`, иначе отказ: новый проект заводит только
 *   `manage_projects` create после согласия человека (решение владельца 21 октября 2026, проекты без вопроса
 *   расплодились папками «Работа», «Встречи», «Дом»). Во внешней группе имя заводит проект, как раньше.
 *
 * Имя сравнивается только по тождеству: регистр, «ё», пробелы и разделитель « · » (SQL-функция
 * `task_project_key` из миграции 161, одна на базу и код). Какой из похожих проектов подходит по смыслу,
 * решает агент, видя список проектов области; код не склеивает «Дом» с «Квартирой».
 *
 * Параллельные записи одного имени сериализуются advisory-блокировкой на область и ключ имени (тот же
 * `task_project_key`, что у индекса), а уникальный индекс `shared_tasks_active_project_title` остаётся
 * последней преградой дубля.
 *
 * В прежнем режиме семьи (legacy) у хода нет области, а личный проект, заведённый до переноса в
 * области, несёт неизменяемую личную область своего автора: точное сравнение `space_id` его не видело и
 * заводило двойника (прод 15 октября 2026: «Встречи», «Работа», «Т-Банк» по два). Поэтому личный проект
 * без области хода находится и в личной области того же автора, а дело записывается в область проекта
 * (`ResolvedProject.spaceId`): переход `NULL` → область триггер разрешает, обратный нет. Семейную и
 * групповую область так не подменяем: их состав мог измениться.
 */
import type { PoolClient } from "pg";

import { AppError } from "./../app-error.js";
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
  /** Область проекта: дело в нём обязано нести её же (`guard_shared_task_project`). */
  readonly spaceId: string | null;
}

/** Живой проект области с таким именем, под замком имени: следующая запись того же имени ждёт этот ход. */
async function findProject(
  client: PoolClient, area: ProjectArea, actorTelegramId: string, name: string,
): Promise<ResolvedProject | null> {
  const owner = area.scope === "personal" ? area.ownerTelegramId ?? actorTelegramId : "";
  // Без области хода личный проект ищется и в личной области автора (см. заголовок): ключ замка
  // поэтому не несёт области, иначе такие записи не сериализовались бы друг с другом.
  const legacyPersonal = area.spaceId === null && area.scope === "personal";
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1 || task_project_key($2),0))",
    [`project:${area.familyId}:${area.scope}:${area.groupId ?? NO_UUID}:${legacyPersonal ? "legacy" : area.spaceId ?? NO_UUID}:${owner}:`, name],
  );
  const found = await client.query<{ id: string; space_id: string | null }>(
    `SELECT p.id, p.space_id FROM shared_tasks p
      WHERE p.kind='project' AND p.status='accepted' AND p.family_id=$1 AND p.scope=$2
        AND p.group_id IS NOT DISTINCT FROM $3::uuid
        AND ($2<>'personal' OR p.creator_telegram_id=$5)
        AND task_project_key(p.title)=task_project_key($6)
        AND (p.space_id IS NOT DISTINCT FROM $4::uuid OR ($7 AND EXISTS (
          SELECT 1 FROM spaces s JOIN users owner ON owner.id=s.owner_user_id
           WHERE s.id=p.space_id AND s.family_id=p.family_id AND s.kind='personal'
             AND owner.telegram_user_id=p.creator_telegram_id)))
      ORDER BY p.space_id IS NULL, p.created_at, p.id
      LIMIT 1`,
    [area.familyId, area.scope, area.groupId, area.spaceId, owner, name, legacyPersonal],
  );
  return found.rows[0] ? { created: false, id: found.rows[0].id, spaceId: found.rows[0].space_id } : null;
}

export async function resolveProject(
  client: PoolClient, area: ProjectArea, actorTelegramId: string, name: string,
  options: { lifeArea?: LifeArea | null; details?: string | null } = {},
): Promise<ResolvedProject> {
  const found = await findProject(client, area, actorTelegramId, name);
  if (found) return found;
  const created = await client.query<{ id: string }>(
    `INSERT INTO shared_tasks(family_id,group_id,scope,creator_telegram_id,assignee_telegram_id,title,status,kind,space_id,life_area,details)
     VALUES($1,$2,$3,$4,$4,task_project_title($5),'accepted','project',$6,$7,$8) RETURNING id`,
    [area.familyId, area.groupId, area.scope, actorTelegramId, name, area.spaceId, options.lifeArea ?? null, options.details ?? null],
  );
  return { created: true, id: created.rows[0]!.id, spaceId: area.spaceId };
}

/**
 * Проект для `listName` дела: только найденный, незнакомое имя это вопрос человеку, а не новый проект. Во внешней
 * группе `manage_projects` нет, поэтому там имя по-прежнему заводит проект группы.
 */
export async function findNamedProject(
  client: PoolClient, area: ProjectArea, actorTelegramId: string, name: string,
): Promise<ResolvedProject> {
  if (area.scope === "group") return await resolveProject(client, area, actorTelegramId, name);
  const found = await findProject(client, area, actorTelegramId, name);
  if (found) return found;
  throw new AppError("AGENT_PROJECT_NOT_FOUND",
    `Проекта «${name}» нет. Запиши дело без listName, затем спроси человека, завести ли такой проект; заводи только после «да» через manage_projects create`);
}
