/**
 * What a task button under a bot message was made for (migration 179).
 *
 * Exports:
 * - `TaskButtonAction`, `TaskButtonRow`: one button's stored meaning.
 * - `TASK_BUTTON_TTL_DAYS`: how long a button keeps working.
 * - `taskButtonRepository`: creates rows for a keyboard, finds a live one by id, records what a pressed
 *   button became and resolves a keyboard from that, says who took the tasks of «Беру» buttons, claims a
 *   «Все дела» press once, purges expired rows.
 *
 * The row is not a grant. It says which task, at which version, what to do, in which chat and for whom;
 * the press is authorized again from Telegram and PostgreSQL (`task-button-callback.ts`), and the task
 * repository checks rights and version as in a chat turn.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { database } from "../database.js";

export type TaskButtonAction =
  | "accept" | "all_tasks" | "claim" | "complete" | "decline" | "reopen"
  | "digest_hour" | "digest_off" | "digest_settings"
  // Under the receipt of a new task (migration 186): who sees it, and the person's one-time default.
  | "share" | "unshare" | "default_family" | "default_personal"
  // Under the receipt of a personal record: into one of the person's ordinary groups (migration 189).
  | "to_group"
  // Under the message about a task that has not moved (migration 192), and «Мои дела» under the group overview.
  | "help_start" | "postpone_week" | "cancel" | "keep" | "my_tasks"
  // «Завершить · проект» inside the board (migration 193).
  | "project_complete"
  // Under a feature tip and the evening reflection (migration 195): no task, the presser's own tip or switch.
  | "tip_try" | "tip_dismiss" | "tips_off" | "evening_off"
  // Under a step card of the first-steps quest (migration 197): the step's number, or nothing for «Позже».
  | "quest_try" | "quest_later";

export const TASK_BUTTON_TTL_DAYS = 7;

export interface TaskButtonRow {
  action: TaskButtonAction;
  chatId: string;
  familyId: string;
  id: string;
  recipientTelegramId: string | null;
  /** Already turned into another button or removed: a replayed press has nothing left to redraw. */
  settled: boolean;
  taskId: string | null;
  taskVersion: number | null;
  /** The hour a `digest_hour` button sets. */
  settingValue: number | null;
  /** The group a `to_group` button moves the record into. */
  targetGroupId: string | null;
  /** The board a board button was drawn in (migration 194): its press redraws that board, not another one. */
  boardQuery: BoardQuery | null;
  /** The feature tip a `tip_try` or `tip_dismiss` button answers (`coach-touches/feature-tips.ts`), or the quest step of `quest_try`. */
  tipNumber: number | null;
}

/** What a board shows: a turn's list filters, or the morning overview's «Все дела». */
export type BoardQuery =
  | { readonly source: "list"; readonly filters: Readonly<Record<string, string>> }
  | { readonly source: "overview" };

export interface ResolvedTaskButton {
  action: TaskButtonAction;
  id: string;
  /** The task's current title; null for «Все дела». */
  title: string | null;
  /** The group of a `to_group` button, for its label. */
  groupTitle?: string | null;
  /** A repeated task: its «✓» keeps 🔁 after a redraw. */
  repeat?: boolean;
  /** The task's status now: a board shows «только что закрыто» only while it is still closed. */
  status?: string | null;
}

export interface TaskButtonItem {
  action: TaskButtonAction;
  /** Absent for `all_tasks` and the overview settings. */
  task?: { id: string; version: number };
  /** The hour of a `digest_hour` button. */
  value?: number;
  /** The group of a `to_group` button. */
  groupId?: string;
  /** The board a board button belongs to. */
  boardQuery?: BoardQuery;
  /** The feature tip of a `tip_try` or `tip_dismiss` button, the quest step of `quest_try`. */
  tip?: number;
}

interface Row {
  action: TaskButtonAction;
  chat_id: string;
  family_id: string;
  id: string;
  recipient_telegram_id: string | null;
  settled: boolean;
  task_id: string | null;
  task_version: number | null;
  setting_value: number | null;
  target_group_id: string | null;
  board_query: BoardQuery | null;
  tip_number: number | null;
}

function fromRow(row: Row): TaskButtonRow {
  return {
    action: row.action,
    chatId: row.chat_id,
    familyId: row.family_id,
    id: row.id,
    recipientTelegramId: row.recipient_telegram_id,
    settled: row.settled,
    taskId: row.task_id,
    taskVersion: row.task_version,
    settingValue: row.setting_value,
    targetGroupId: row.target_group_id,
    boardQuery: row.board_query ?? null,
    tipNumber: row.tip_number ?? null,
  };
}

export const taskButtonRepository = {
  /** One row per item, in order; the ids go into the keyboard as `tb:<id>`. */
  async create(
    input: {
      chatId: string;
      familyId: string;
      items: readonly TaskButtonItem[];
      now: Date;
      /** The only person the button is for; null in a family group, where any live member may press. */
      recipientTelegramId: string | null;
    },
    client?: PoolClient,
  ): Promise<string[]> {
    if (input.items.length === 0) return [];
    const ids = input.items.map(() => randomUUID());
    const values: unknown[] = [input.familyId, input.chatId, input.recipientTelegramId, input.now, TASK_BUTTON_TTL_DAYS];
    const tuples = input.items.map((item, index) => {
      values.push(ids[index], item.action, item.task?.id ?? null, item.task?.version ?? null, item.value ?? null, item.groupId ?? null,
        item.boardQuery ? JSON.stringify(item.boardQuery) : null, item.tip ?? null);
      const base = 6 + index * 8;
      return `($${base}::uuid, $1::uuid, $2, $3, $4::timestamptz, $4::timestamptz + $5::integer * interval '1 day', $${base + 1}, $${base + 2}::uuid, $${base + 3}::integer, $${base + 4}::smallint, $${base + 5}::uuid, $${base + 6}::jsonb, $${base + 7}::smallint)`;
    });
    await (client ?? database()).query(
      `INSERT INTO task_button_actions
         (id, family_id, chat_id, recipient_telegram_id, created_at, expires_at, action, task_id, task_version, setting_value,
          target_group_id, board_query, tip_number)
       VALUES ${tuples.join(", ")}`,
      values,
    );
    return ids;
  },

  async find(id: string, now: Date): Promise<TaskButtonRow | null> {
    const result = await database().query<Row>(
      `SELECT id, family_id, chat_id, recipient_telegram_id, task_id, task_version, action, setting_value, target_group_id, board_query,
              tip_number, (replaced_by IS NOT NULL OR removed_at IS NOT NULL) AS settled
         FROM task_button_actions WHERE id = $1 AND expires_at > $2`,
      [id, now],
    );
    const row = result.rows[0];
    return row ? fromRow(row) : null;
  },

  /** The pressed button became another one; the keyboard is redrawn from this, not from the update. */
  async markReplaced(id: string, replacementId: string): Promise<void> {
    await database().query("UPDATE task_button_actions SET replaced_by = $2, removed_at = NULL WHERE id = $1", [id, replacementId]);
  },

  /**
   * «Для семьи» and «Только мне» are one question, answered once: the pressed button and its pair go away and the
   * choice is saved in one transaction. False when the pressed one was already spent: an old press replayed after a
   * later change must not bring the earlier answer back.
   */
  async answerDefaultChoice(
    input: { familyId: string; ids: readonly string[]; now: Date; pressedId: string; userId: string; visibility: "family" | "personal" },
  ): Promise<boolean> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const spent = await client.query(
        `UPDATE task_button_actions SET removed_at = $2, replaced_by = NULL
          WHERE id = ANY($1::uuid[]) AND action IN ('default_family', 'default_personal') AND removed_at IS NULL
          RETURNING id`,
        [[...new Set([input.pressedId, ...input.ids])], input.now],
      );
      const answered = spent.rows.some((row: { id: string }) => row.id === input.pressedId);
      if (answered) {
        await client.query(
          `INSERT INTO user_notification_settings(user_id, timezone, default_task_visibility)
           VALUES ($1, COALESCE((SELECT settings.timezone FROM user_notification_settings AS settings
                                   JOIN family_memberships AS membership ON membership.user_id = settings.user_id
                                  WHERE membership.family_id = $2 AND membership.role = 'owner'), 'UTC'), $3)
           ON CONFLICT (user_id) DO UPDATE SET default_task_visibility = EXCLUDED.default_task_visibility, updated_at = now()`,
          [input.userId, input.familyId, input.visibility],
        );
      }
      await client.query("COMMIT");
      return answered;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Buttons of this message about one task go: all of them once the record moved into a group, or only its «В группу»
   * ones (`only`) once it became shared, since a shared record does not move.
   */
  async removeForTask(ids: readonly string[], taskId: string, now: Date, only: TaskButtonAction | null = null): Promise<void> {
    if (ids.length === 0) return;
    await database().query(
      `UPDATE task_button_actions SET removed_at = $3, replaced_by = NULL
        WHERE id = ANY($1::uuid[]) AND task_id = $2 AND ($4::text IS NULL OR action = $4)`,
      [[...ids], taskId, now, only]);
  },

  /** Buttons a redrawn board no longer shows; a button already replaced or removed stays as it is. */
  async retire(ids: readonly string[], now: Date): Promise<void> {
    if (ids.length === 0) return;
    await database().query(
      "UPDATE task_button_actions SET removed_at = $2 WHERE id = ANY($1::uuid[]) AND removed_at IS NULL AND replaced_by IS NULL",
      [[...ids], now]);
  },

  async markRemoved(id: string, now: Date): Promise<void> {
    await database().query("UPDATE task_button_actions SET removed_at = $2, replaced_by = NULL WHERE id = $1", [id, now]);
  },

  /**
   * What each button of a message is now: the last one in its chain of replacements with its task's
   * title, or null when it was removed. Ids without a row (expired, another message) are left out.
   */
  async resolve(ids: readonly string[]): Promise<Map<string, ResolvedTaskButton | null>> {
    const resolved = new Map<string, ResolvedTaskButton | null>();
    if (ids.length === 0) return resolved;
    const result = await database().query<{
      action: TaskButtonAction; final_id: string; group_title: string | null; origin: string; removed: boolean; repeat: boolean;
      status: string | null; title: string | null;
    }>(
      `WITH RECURSIVE chain(origin, id, depth) AS (
         SELECT id, id, 0 FROM task_button_actions WHERE id = ANY($1::uuid[])
         UNION ALL
         SELECT chain.origin, button.replaced_by, chain.depth + 1
           FROM chain JOIN task_button_actions button ON button.id = chain.id
          WHERE button.replaced_by IS NOT NULL AND chain.depth < 50
       ), last AS (
         SELECT DISTINCT ON (origin) origin, id FROM chain ORDER BY origin, depth DESC
       )
       SELECT last.origin, button.id AS final_id, button.action, button.removed_at IS NOT NULL AS removed, task.title,
              COALESCE(task.recurrence_unit IS NOT NULL, false) AS repeat, task.status::text AS status,
              grp.title AS group_title
         FROM last
         JOIN task_button_actions button ON button.id = last.id
         LEFT JOIN shared_tasks task ON task.id = button.task_id AND task.family_id = button.family_id
         LEFT JOIN telegram_groups grp ON grp.id = button.target_group_id AND grp.family_id = button.family_id`,
      [ids],
    );
    for (const row of result.rows) {
      resolved.set(row.origin, row.removed ? null
        : { action: row.action, groupTitle: row.group_title, id: row.final_id, repeat: row.repeat, status: row.status, title: row.title });
    }
    return resolved;
  },

  /**
   * Who holds the task of each spent «Беру» button now, in the order of `ids`: the group overview shows
   * it under the message. A task taken in words or given back is told as it is now, not as pressed.
   */
  async claimed(ids: readonly string[]): Promise<Array<{ name: string; title: string }>> {
    if (ids.length === 0) return [];
    const result = await database().query<{ id: string; name: string; title: string }>(
      `SELECT button.id, assignee.display_name AS name, task.title
         FROM task_button_actions button
         JOIN shared_tasks task ON task.id = button.task_id AND task.family_id = button.family_id
         JOIN users assignee ON assignee.telegram_user_id = task.assignee_telegram_id
        WHERE button.id = ANY($1::uuid[]) AND button.action = 'claim' AND button.removed_at IS NOT NULL
          AND task.status = 'accepted'`,
      [ids],
    );
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [{ name: row.name, title: row.title }] : [];
    });
  },

  /**
   * After an answer the other answers to the same task in this chat are moot: «Беру» removes its
   * «Не могу», and a claimed task's button disappears from every message in the chat.
   */
  async markAnswersRemoved(row: { chatId: string; id: string; taskId: string }, now: Date): Promise<void> {
    await database().query(
      `UPDATE task_button_actions SET removed_at = $4
        WHERE task_id = $1 AND chat_id = $2 AND id <> $3 AND action IN ('accept', 'decline', 'claim')
          AND replaced_by IS NULL AND removed_at IS NULL`,
      [row.taskId, row.chatId, row.id, now],
    );
  },

  /** True once per press: a replay of the same update after a crash must not send the board again. */
  async claimDispatch(id: string, callbackQueryId: string): Promise<boolean> {
    const result = await database().query(
      `UPDATE task_button_actions SET dispatched_query_id = $2
        WHERE id = $1 AND dispatched_query_id IS DISTINCT FROM $2`,
      [id, callbackQueryId],
    );
    return (result.rowCount ?? 0) === 1;
  },

  async purgeExpired(now: Date): Promise<number> {
    const result = await database().query("DELETE FROM task_button_actions WHERE expires_at <= $1", [now]);
    return result.rowCount ?? 0;
  },
};
