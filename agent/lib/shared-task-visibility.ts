/**
 * Кто видит дело, записанное в личке: только автор или вся семья (онбординг v3, 19 октября 2026).
 *
 * Exports:
 * - `TaskVisibility`: «семья» или «только мне».
 * - `privateTaskScope`: в какую область пишет новое дело из лички, по поручению и по выбору человека.
 * - `readDefaultTaskVisibility`, `writeDefaultTaskVisibility`: выбор человека, заданный один раз.
 * - `adoptFirstTaskVisibility`: первый явный выбор в Mini App становится этим выбором, если его ещё не было.
 * - `sharedTaskVisibility`: «Сделать общим» и «Сделать личным» для уже записанного дела и «В группу «…»» для
 *   личного, одной транзакцией с повтором по ключу операции, как любое изменение дела.
 *
 * Key constructs:
 * - Семейное дело из лички пишется только в прежнем режиме семьи (без пространств): там у семейного дела нет
 *   области (`space_id` NULL), а видимость решает личность. В режиме пространств общая область выбирается в чате,
 *   и личка честно отказывает.
 * - Поручение другому взрослому всегда семейное: тот, кого просят, должен его видеть (решение владельца).
 * - Традиция без выбора следует выбору человека, как дело: пока его не спрашивали, она личная.
 * - В группу (решение владельца 20 октября, `GRP-09`) уходит только личная запись автора без области, пока она
 *   касается только его; из семьи и из одной группы в другую записи не переносятся. Что человек сейчас в чате
 *   группы, проверяет вызывающий в Telegram до транзакции, а здесь под блокировкой проверяется сама группа.
 * - Идея и традиция без области меняются на месте в обе стороны; личной снова только пока никто кроме автора
 *   её не запланировал и не отметил.
 * - Область записи неизменна после записи (миграция 104). Дело без области меняет только `scope`; у дела с личной
 *   областью «Сделать общим» снимает его и заводит общую копию: другой путь база не разрешает.
 * - Проект своей области: общее дело не может остаться в личном проекте (и наоборот), поэтому при смене
 *   видимости дело выходит из проекта, а имя списка остаётся подписью.
 */
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import { authorize, denied, present, readTasks, type TaskRow } from "./shared-task-access.js";
import { recordTaskVersion } from "./shared-task-handover.js";
import { lockTaskForChange } from "./shared-task-transition.js";
import { readFamilySpaceMode } from "./spaces/family-space-mode.js";

export type TaskVisibility = "family" | "personal";

function spacesRefusal(): never {
  throw new AppError(
    "AGENT_TASK_SHARED_NEEDS_SPACE",
    "В этой семье общие дела записываются в общей области: переключитесь на неё в чате или напишите в семейную группу",
  );
}

export async function readDefaultTaskVisibility(client: PoolClient, userId: string): Promise<TaskVisibility | null> {
  const { rows } = await client.query<{ default_task_visibility: TaskVisibility | null }>(
    "SELECT default_task_visibility FROM user_notification_settings WHERE user_id = $1", [userId]);
  return rows[0]?.default_task_visibility ?? null;
}

/** The row may not exist yet: it is created in the family owner's zone, as the overview and coach settings do. */
export async function writeDefaultTaskVisibility(input: { familyId: string; userId: string; visibility: TaskVisibility }): Promise<void> {
  await database().query(
    `INSERT INTO user_notification_settings(user_id, timezone, default_task_visibility)
     VALUES ($1, COALESCE((SELECT settings.timezone FROM user_notification_settings AS settings
                             JOIN family_memberships AS membership ON membership.user_id = settings.user_id
                            WHERE membership.family_id = $2 AND membership.role = 'owner'), 'UTC'), $3)
     ON CONFLICT (user_id) DO UPDATE SET default_task_visibility = EXCLUDED.default_task_visibility, updated_at = now()`,
    [input.userId, input.familyId, input.visibility],
  );
}

/**
 * The scope and area of a task a private chat creates without a project: shared for an assignment to another adult
 * or when the person chose «Для семьи» (the default, or `visibility` sent by the Mini App for this one task); otherwise
 * personal in the chat's own area. A tradition follows the same choice: a family is not one circle (the owner's
 * traditions with his mother are not his wife's), so none is shared by its kind alone; the receipt says who sees it and
 * offers «Показать семье». With spaces a shared one needs the shared area, so an assignment and «Для семьи» are refused.
 */
export async function privateTaskScope(
  client: PoolClient, auth: MemoryAuthorization, chatSpaceId: string | null,
  input: { assigneeRef?: string | undefined; visibility?: TaskVisibility | undefined },
): Promise<{ scope: MemoryScope; spaceId: string | null }> {
  const personal = { scope: "personal" as const, spaceId: chatSpaceId };
  if (input.assigneeRef !== undefined && input.visibility === "personal") {
    throw new AppError("AGENT_TASK_VISIBILITY_SHARED_WORK", "Дело для другого человека видите вы оба, только вашим его не записать");
  }
  const explicit = input.assigneeRef !== undefined ? "family" : input.visibility;
  if (explicit === "personal") return personal;
  const wanted = explicit ?? (auth.userId !== null ? await readDefaultTaskVisibility(client, auth.userId) : null);
  if (wanted !== "family") return personal;
  if (await readFamilySpaceMode(client, auth.familyId) !== "legacy") spacesRefusal();
  return { scope: "family", spaceId: null };
}

/**
 * The first explicit choice of a person not asked yet becomes their default, as the receipt's one-time question does;
 * a later choice is for that one task only. Written in the caller's transaction, so a refused task changes nothing.
 */
export async function adoptFirstTaskVisibility(client: PoolClient, auth: MemoryAuthorization, visibility: TaskVisibility): Promise<void> {
  if (auth.userId === null) return;
  await client.query(
    `INSERT INTO user_notification_settings(user_id, timezone, default_task_visibility)
     VALUES ($1, COALESCE((SELECT settings.timezone FROM user_notification_settings AS settings
                             JOIN family_memberships AS membership ON membership.user_id = settings.user_id
                            WHERE membership.family_id = $2 AND membership.role = 'owner'), 'UTC'), $3)
     ON CONFLICT (user_id) DO UPDATE SET default_task_visibility = EXCLUDED.default_task_visibility, updated_at = now()
      WHERE user_notification_settings.default_task_visibility IS NULL`,
    [auth.userId, auth.familyId, visibility],
  );
}

/**
 * Only the author changes who sees a task, and only a task of the private chat's own two scopes. An idea or a
 * tradition without a written area changes in place (nothing is copied). It is read through the plans and marks of
 * whoever picked it up, so it goes personal again only while nobody else planned or marked it; the task row is locked
 * (`lockTaskForChange`), and a plan or a mark takes the same lock, so none can slip in between.
 */
async function requireChangeable(client: PoolClient, auth: MemoryAuthorization, task: TaskRow, to: TaskVisibility): Promise<void> {
  if (task.creator_telegram_id !== auth.telegramUserId || task.scope === "group") denied();
  const inPlace = (task.kind === "idea" || task.kind === "ritual") && task.space_id === null;
  if (task.kind !== "task" && !inPlace) denied();
  if (task.scope === to) {
    throw new AppError("AGENT_TASK_VISIBILITY_UNCHANGED", to === "family" ? "Это дело уже общее" : "Это дело уже только ваше");
  }
  if (!["open", "proposed", "accepted"].includes(task.status)) {
    throw new AppError("AGENT_TASK_VISIBILITY_CLOSED", "Закрытое дело так и останется, как было записано");
  }
  if (to === "personal" && (task.assignee_telegram_id !== auth.telegramUserId || task.care_area_id !== null
    || task.pending_assignee_telegram_id !== null)) {
    throw new AppError("AGENT_TASK_VISIBILITY_SHARED_WORK",
      "Это дело уже касается другого человека или области заботы, личным его не сделать");
  }
  if (to === "personal" && task.kind !== "task" && await pickedUpByOthers(client, task.id, auth.telegramUserId!)) {
    throw new AppError("AGENT_TASK_VISIBILITY_SHARED_WORK",
      "Это уже подхватил кто-то ещё в семье: запланировал или отметил. Личным его не сделать");
  }
}

/** Whether someone besides the author planned an idea or marked a tradition: then it is no longer only theirs. */
async function pickedUpByOthers(client: PoolClient, taskId: string, authorTelegramId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM shared_task_plans WHERE task_id = $1 AND telegram_user_id <> $2
     UNION ALL SELECT 1 FROM shared_ritual_occurrences WHERE task_id = $1 AND actor_telegram_id <> $2
     LIMIT 1`, [taskId, authorTelegramId]);
  return (rowCount ?? 0) > 0;
}

/** A personal record of its author alone, without an area, moves into one ordinary group of the same family, in place. */
async function moveToGroup(client: PoolClient, auth: MemoryAuthorization, task: TaskRow, groupId: string): Promise<string> {
  if (task.creator_telegram_id !== auth.telegramUserId || task.scope !== "personal" || task.space_id !== null) denied();
  if (task.kind !== "task" && task.kind !== "idea" && task.kind !== "ritual") denied();
  if (!["open", "proposed", "accepted"].includes(task.status)) {
    throw new AppError("AGENT_TASK_VISIBILITY_CLOSED", "Закрытое дело так и останется, как было записано");
  }
  if (task.care_area_id !== null || task.pending_assignee_telegram_id !== null) {
    throw new AppError("AGENT_TASK_VISIBILITY_SHARED_WORK", "Это дело уже касается области заботы или другого человека");
  }
  // The group's members are not the family: they get only what the button showed, the title. A record with details or
  // an earlier version (whose text a group read would show as the original) is written there anew instead.
  const history = await client.query("SELECT 1 FROM shared_task_versions WHERE task_id = $1 LIMIT 1", [task.id]);
  if (task.details !== null || (history.rowCount ?? 0) > 0) {
    throw new AppError("AGENT_TASK_TO_GROUP_HAS_HISTORY",
      "У этой записи уже есть подробности или правки. Запишите её в группе заново, чтобы туда попало только нужное");
  }
  if (await readFamilySpaceMode(client, auth.familyId) !== "legacy") spacesRefusal();
  const group = await client.query(
    `SELECT 1 FROM telegram_groups WHERE id = $1 AND family_id = $2 AND type = 'external'
        AND 'manage_shared_tasks' = ANY(tool_allowlist) FOR SHARE`, [groupId, auth.familyId]);
  if ((group.rowCount ?? 0) === 0) denied();
  await recordTaskVersion(client, task, "to_group", auth.telegramUserId!);
  // The personal list's name and the life area are the author's own words about it, not the group's.
  await client.query(
    `UPDATE shared_tasks SET scope = 'group', group_id = $2, project_id = NULL, list_name = NULL, life_area = NULL,
            version = version + 1, updated_at = now() WHERE id = $1`,
    [task.id, groupId]);
  return task.id;
}

async function changeVisibility(client: PoolClient, auth: MemoryAuthorization, task: TaskRow, to: TaskVisibility): Promise<string> {
  await requireChangeable(client, auth, task, to);
  if (await readFamilySpaceMode(client, auth.familyId) !== "legacy") spacesRefusal();
  const action = to === "family" ? "share" : "unshare";
  if (task.space_id === null) {
    await recordTaskVersion(client, task, action, auth.telegramUserId!);
    await client.query(
      "UPDATE shared_tasks SET scope = $2, project_id = NULL, version = version + 1, updated_at = now() WHERE id = $1",
      [task.id, to],
    );
    return task.id;
  }
  // A task with its area written keeps it for ever (migration 104): the shared copy is a new record, the personal
  // original is removed with the reason in its history. Only personal → family reaches here: shared tasks of a
  // legacy family have no area, and the two with one are refused as already shared work above or below.
  if (to !== "family") {
    throw new AppError("AGENT_TASK_VISIBILITY_SHARED_WORK", "Это дело записано в общей области, личным его не сделать");
  }
  // The copy would lose what hangs on the original (a plan, a reminder, a repeat's count): such a task is written anew.
  const attached = await client.query(
    `SELECT 1 FROM shared_task_plans WHERE task_id = $1
     UNION ALL SELECT 1 FROM reminders WHERE shared_task_id = $1 AND status IN ('active', 'leased', 'paused')
     LIMIT 1`, [task.id]);
  if (task.recurrence_unit !== null || (attached.rowCount ?? 0) > 0) {
    throw new AppError("AGENT_TASK_VISIBILITY_ATTACHED",
      "У этого дела есть повтор, план или напоминание, общим его так не сделать. Попросите записать его заново для семьи");
  }
  const copy = await client.query<{ id: string }>(
    `INSERT INTO shared_tasks(family_id,group_id,scope,creator_telegram_id,assignee_telegram_id,title,due_at,status,kind,list_name,
       details,due_on,space_id,recurrence_unit,recurrence_interval,recurrence_anchor_on,life_area)
     SELECT family_id,NULL,'family',creator_telegram_id,assignee_telegram_id,title,due_at,status,kind,list_name,
       details,due_on,NULL,recurrence_unit,recurrence_interval,recurrence_anchor_on,life_area
       FROM shared_tasks WHERE id = $1 RETURNING id`,
    [task.id],
  );
  await recordTaskVersion(client, task, action, auth.telegramUserId!);
  await client.query("UPDATE shared_tasks SET status = 'cancelled', version = version + 1, updated_at = now() WHERE id = $1", [task.id]);
  return copy.rows[0]!.id;
}

export const sharedTaskVisibility = {
  /** «Сделать общим» / «Сделать личным» from a private chat; the result is the task as it now is (a copy may have a new id). */
  async change(
    auth: MemoryAuthorization,
    input: { id: string; version: number } & ({ visibility: TaskVisibility } | { groupId: string }),
    operationKey: string,
  ): Promise<{ task: ReturnType<typeof present>; replayed: boolean }> {
    if (auth.groupId !== null || !operationKey || operationKey.length > 500) denied();
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const scope = await authorize(client, auth);
      const hash = createHash("sha256").update(JSON.stringify({ actor: auth.telegramUserId, input, kind: "visibility" })).digest("hex");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${auth.familyId}:${operationKey}`]);
      const previous = await client.query<{ request_hash: string; task_id: string }>(
        "SELECT request_hash, task_id FROM shared_task_operations WHERE family_id = $1 AND operation_key = $2",
        [auth.familyId, operationKey]);
      let id: string;
      let replayed = false;
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== hash) denied();
        id = previous.rows[0].task_id;
        replayed = true;
      } else {
        const task = await lockTaskForChange(client, auth, scope, { action: "update", id: input.id, version: input.version } as never);
        id = "groupId" in input
          ? await moveToGroup(client, auth, task, input.groupId)
          : await changeVisibility(client, auth, task, input.visibility);
        await client.query(
          "INSERT INTO shared_task_operations(family_id,operation_key,actor_telegram_id,request_hash,task_id) VALUES($1,$2,$3,$4,$5)",
          [auth.familyId, operationKey, auth.telegramUserId, hash, id]);
        await client.query(
          `INSERT INTO audit_events(family_id,actor_user_id,event_type,subject_id,metadata)
           VALUES($1,$2,'shared_task.visibility',$3,jsonb_build_object('visibility',$4::text,'from',$5::text))`,
          [auth.familyId, auth.userId, id, "groupId" in input ? `group:${input.groupId}` : input.visibility, input.id]);
      }
      // A record moved into a group is no longer the private chat's to read: it is answered from the row itself.
      if ("groupId" in input) {
        const moved = await client.query<{ id: string; title: string; version: number }>(
          "SELECT id, title, version FROM shared_tasks WHERE id = $1 AND group_id = $2 AND scope = 'group'", [id, input.groupId]);
        if (!moved.rows[0]) denied();
        await client.query("COMMIT");
        return { replayed, task: { ...moved.rows[0] } as unknown as ReturnType<typeof present> };
      }
      const { rows } = await readTasks(client, auth, scope, id);
      if (!rows[0]) denied();
      await client.query("COMMIT");
      return { replayed, task: present(rows[0], true) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
