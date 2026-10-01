/**
 * Данные утреннего разбора семейных дел: в какие группы писать, что в них сказать и заявка на сутки.
 *
 * Экспорт:
 * - `OverviewGroup`: семейная группа, которой сегодня можно написать, с поясом семьи.
 * - `groupOverviewRepository`: группы, общие дела, заявка на сутки и выключатель.
 *
 * Пишет только в семейную группу (`family_private`), где за последнюю неделю кто-то писал: в мёртвую
 * группу утро ничего не скажет, а внешние группы к семейным делам отношения не имеют. Дела берутся
 * только общие (`scope = 'family'`): личное в чат двоих не попадает. В режиме пространств семья
 * отвечает за область по-другому, и разбор молчит, пока для него нет своей проверки (см. `tasks`).
 */
import { database } from "../database.js";
import { readFamilySpaceMode } from "../spaces/family-space-mode.js";
import type { GroupOverviewTask } from "./group-overview.js";

/** Группа, где давно никто не пишет, разбора не получает. */
export const GROUP_OVERVIEW_ACTIVITY_DAYS = 7;

export interface OverviewGroup {
  readonly familyId: string;
  readonly firstEver: boolean;
  readonly groupId: string;
  readonly telegramChatId: string;
  /** Пояс владельца семьи: у группы своего пояса нет. */
  readonly timezone: string;
}

interface GroupRow {
  family_id: string;
  first_ever: boolean;
  group_id: string;
  telegram_chat_id: string;
  timezone: string;
}

interface TaskRow {
  assignee_name: string | null;
  due_at: Date | null;
  due_on: string | null;
  kind: string;
  life_area: string | null;
  list_name: string | null;
  status: string;
  title: string;
}

export const groupOverviewRepository = {
  async groups(now: Date): Promise<OverviewGroup[]> {
    const { rows } = await database().query<GroupRow>(
      `SELECT g.id AS group_id, g.family_id, g.telegram_chat_id,
              COALESCE(owner_settings.timezone, 'UTC') AS timezone,
              NOT EXISTS (SELECT 1 FROM group_overview_claims AS claim WHERE claim.group_id = g.id) AS first_ever
         FROM telegram_groups AS g
         LEFT JOIN LATERAL (
           SELECT membership.user_id FROM family_memberships AS membership
            WHERE membership.family_id = g.family_id AND membership.role = 'owner' LIMIT 1
         ) AS owner ON true
         LEFT JOIN user_notification_settings AS owner_settings ON owner_settings.user_id = owner.user_id
        WHERE g.type = 'family_private' AND g.daily_overview_enabled
          AND EXISTS (SELECT 1 FROM telegram_group_messages AS message
                       WHERE message.group_id = g.id AND NOT message.sender_is_bot
                         AND message.sent_at > $1::timestamptz - make_interval(days => $2))
        ORDER BY g.created_at, g.id`,
      [now, GROUP_OVERVIEW_ACTIVITY_DAYS],
    );
    return rows.map((row) => ({
      familyId: row.family_id, firstEver: row.first_ever, groupId: row.group_id,
      telegramChatId: row.telegram_chat_id, timezone: row.timezone,
    }));
  },

  /** Общие дела семьи с именем того, кому поручено. Личные дела сюда не попадают ни при каких условиях. */
  async tasks(group: OverviewGroup): Promise<GroupOverviewTask[]> {
    const client = await database().connect();
    try {
      // Пока семья в режиме пространств, общие дела живут в областях, и здесь нет проверки, какие
      // из них группе видны: молчание безопаснее, чем показать лишнее.
      if (await readFamilySpaceMode(client, group.familyId) !== "legacy") return [];
      const { rows } = await client.query<TaskRow>(
        `SELECT task.title, task.status, task.kind, COALESCE(project.title, task.list_name) AS list_name,
                task.due_on::text AS due_on, task.due_at, task.life_area, assignee.display_name AS assignee_name
           FROM shared_tasks AS task
           LEFT JOIN shared_tasks AS project ON project.id = task.project_id
           LEFT JOIN users AS assignee ON assignee.telegram_user_id = task.assignee_telegram_id
          WHERE task.family_id = $1 AND task.scope = 'family' AND task.kind <> 'project'
            AND task.status IN ('open', 'proposed', 'accepted')
          ORDER BY task.created_at, task.id
          LIMIT 300`,
        [group.familyId],
      );
      return rows.map((row) => ({
        assigneeName: row.assignee_name,
        dueAt: row.due_at?.toISOString() ?? null,
        dueOn: row.due_on,
        kind: row.kind,
        lifeArea: row.life_area as GroupOverviewTask["lifeArea"],
        listName: row.list_name,
        source: "Семейное",
        status: row.status,
        title: row.title,
      }));
    } finally {
      client.release();
    }
  },

  /** Заявка на сутки: повтор невозможен по ключу, а не по проверке в коде. */
  async claim(group: OverviewGroup, localDate: string): Promise<string | null> {
    const inserted = await database().query<{ delivery_ref: string }>(
      `INSERT INTO group_overview_claims(group_id, sent_on) VALUES ($1, $2::date)
       ON CONFLICT DO NOTHING RETURNING delivery_ref`,
      [group.groupId, localDate],
    );
    return inserted.rows[0]?.delivery_ref ?? null;
  },

  /** Выключатель на все семейные группы семьи; число групп нужно, чтобы не рапортовать об успехе впустую. */
  async setEnabled(familyId: string, enabled: boolean): Promise<number> {
    const result = await database().query(
      `UPDATE telegram_groups SET daily_overview_enabled = $2
        WHERE family_id = $1 AND type = 'family_private'`,
      [familyId, enabled],
    );
    return result.rowCount ?? 0;
  },
};
