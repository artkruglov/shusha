/**
 * Чтения Mini App, которых нет у репозитория дел: история версий, автор и область дела, имена семьи,
 * закрытия недели.
 *
 * Exports:
 * - `webAppQueries`: запросы в контексте семьи (`withFamilyDatabaseContext` ставит API).
 *
 * Каждый запрос ограничен семьёй человека, а история и факты дела читаются только после того, как
 * репозиторий дел отдал само дело по `get` с правами лички: этот модуль права не решает, он дочитывает.
 * `visibleTitles` читает тем же правилом, что `get` (`readTasks`), просто сразу для многих дел.
 * Дела внешних групп сюда не попадают (`scope <> 'group'`).
 */
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { authorize, readTasks } from "../shared-task-access.js";
import type { ClosedCandidate } from "./web-app-closed.js";
import type { TaskVersionRow } from "./web-app-task-card.js";

/** Сколько закрытых дел за неделю показать: неделя семьи редко больше, а страница не должна тянуть сотни `get`. */
const CLOSED_LIMIT = 60;

export const webAppQueries = {
  /**
   * Titles of the tasks among `ids` the task repository gives this person, read in one transaction by the same rule
   * as its `get` (`readTasks`), without an external group's. «Закрытые» used to ask once per task.
   */
  async visibleTitles(auth: MemoryAuthorization, ids: readonly string[]): Promise<Map<string, { title: string; version: number }>> {
    if (ids.length === 0) return new Map();
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const scope = await authorize(client, auth);
      const { rows } = await readTasks(client, auth, scope, ids);
      await client.query("COMMIT");
      return new Map(rows.filter((row) => row.scope !== "group").map((row) => [row.id, { title: row.title, version: row.version }]));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /** Who each participant reference is, to put the person first as «Мне». */
  async participantPeople(familyId: string, refs: readonly string[]): Promise<Map<string, string>> {
    if (refs.length === 0) return new Map();
    const { rows } = await database().query<{ id: string; telegram_user_id: string }>(
      "SELECT id, telegram_user_id FROM shared_task_participants WHERE family_id = $1 AND id = ANY($2::uuid[])", [familyId, refs]);
    return new Map(rows.map((row) => [row.id, row.telegram_user_id]));
  },

  async names(familyId: string): Promise<Map<string, string>> {
    const { rows } = await database().query<{ display_name: string; telegram_user_id: string }>(
      `SELECT person.telegram_user_id, person.display_name FROM family_memberships membership
         JOIN users person ON person.id = membership.user_id
        WHERE membership.family_id = $1 AND person.telegram_user_id IS NOT NULL`,
      [familyId],
    );
    return new Map(rows.map((row) => [row.telegram_user_id, row.display_name]));
  },

  async taskFacts(familyId: string, taskId: string): Promise<{
    assigneeTelegramId: string | null; createdAt: Date; creatorTelegramId: string; inPlace: boolean;
    pendingAssigneeTelegramId: string | null; pickedUpByOthers: boolean; space: string | null;
  } | null> {
    const { rows } = await database().query<{
      assignee_telegram_id: string | null; created_at: Date; creator_telegram_id: string; in_place: boolean;
      pending_assignee_telegram_id: string | null; picked_up_by_others: boolean; space: string | null;
    }>(
      `SELECT task.assignee_telegram_id, task.pending_assignee_telegram_id, task.created_at, task.creator_telegram_id, task.space_id IS NULL AS in_place,
              space.title AS space,
              (EXISTS (SELECT 1 FROM shared_task_plans plan
                        WHERE plan.task_id = task.id AND plan.telegram_user_id <> task.creator_telegram_id)
               OR EXISTS (SELECT 1 FROM shared_ritual_occurrences mark
                           WHERE mark.task_id = task.id AND mark.actor_telegram_id <> task.creator_telegram_id))
                AS picked_up_by_others
         FROM shared_tasks task LEFT JOIN spaces space ON space.id = task.space_id AND space.kind <> 'personal'
        WHERE task.id = $1 AND task.family_id = $2 AND task.scope <> 'group'`,
      [taskId, familyId],
    );
    const row = rows[0];
    return row ? {
      assigneeTelegramId: row.assignee_telegram_id, createdAt: row.created_at,
      creatorTelegramId: row.creator_telegram_id, inPlace: row.in_place,
      pendingAssigneeTelegramId: row.pending_assignee_telegram_id, pickedUpByOthers: row.picked_up_by_others,
      space: row.space,
    } : null;
  },

  async history(familyId: string, taskId: string): Promise<TaskVersionRow[]> {
    const { rows } = await database().query<{
      action: string; actor_telegram_id: string; created_at: Date; previous_record: TaskVersionRow["before"];
    }>(
      `SELECT version.action, version.actor_telegram_id, version.created_at, version.previous_record
         FROM shared_task_versions version JOIN shared_tasks task ON task.id = version.task_id
        WHERE version.task_id = $1 AND task.family_id = $2
        ORDER BY version.version`,
      [taskId, familyId],
    );
    return rows.map((row) => ({
      action: row.action, actorTelegramId: row.actor_telegram_id, at: row.created_at, before: row.previous_record ?? {},
    }));
  },

  /** Закрытия недели по местным суткам человека: последнее у обычного дела, каждое у повторяющегося. */
  async closed(familyId: string, week: { from: string; until: string }, timezone: string): Promise<ClosedCandidate[]> {
    const { rows } = await database().query<{
      action: "cancel" | "complete"; actor_telegram_id: string; assignee_telegram_id: string | null; created_at: Date;
      creator_telegram_id: string; repeat: boolean; task_id: string;
    }>(
      `WITH closing AS (
         SELECT version.task_id, version.version, version.action, version.actor_telegram_id, version.created_at,
                task.recurrence_unit IS NOT NULL AS repeat, task.status, task.creator_telegram_id, task.assignee_telegram_id,
                row_number() OVER (PARTITION BY version.task_id ORDER BY version.version DESC) AS latest
           FROM shared_task_versions version JOIN shared_tasks task ON task.id = version.task_id
          WHERE task.family_id = $1 AND task.scope <> 'group' AND task.kind = 'task'
            AND version.action IN ('complete', 'cancel')
            AND version.created_at >= ($2::date::timestamp AT TIME ZONE $4)
            AND version.created_at < (($3::date + 1)::timestamp AT TIME ZONE $4))
       SELECT task_id, action, actor_telegram_id, created_at, repeat, creator_telegram_id, assignee_telegram_id
         FROM closing
        WHERE repeat OR (latest = 1 AND status = CASE action WHEN 'complete' THEN 'completed' ELSE 'cancelled' END)
        ORDER BY created_at DESC
        LIMIT $5`,
      [familyId, week.from, week.until, timezone, CLOSED_LIMIT],
    );
    return rows.map((row) => ({
      action: row.action, actorTelegramId: row.actor_telegram_id, assigneeTelegramId: row.assignee_telegram_id,
      at: row.created_at, creatorTelegramId: row.creator_telegram_id, repeat: row.repeat, taskId: row.task_id,
    }));
  },
};
