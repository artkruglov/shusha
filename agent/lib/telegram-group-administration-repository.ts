/**
 * PostgreSQL Telegram group administration repository.
 *
 * Exports:
 * - `TelegramGroupRegistration`: complete persisted registration input.
 * - `TelegramGroupPolicyUpdate`: complete external-group policy replacement input.
 * - `TelegramGroupStatus`: complete read-only registration and policy projection.
 * - `TelegramGroupSessionRotation`: owner-requested canonical rotation for every group topic.
 * - `TelegramGroupAdministrationRepository`: injectable registration/removal/policy contract.
 * - `telegramGroupAdministrationRepository`: family-scoped group lifecycle operations.
 */
import {
  SESSION_GROUP_ROTATION_LOCK_HASH_SEED,
  TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED,
} from "../config.js";
import { AppError } from "./app-error.js";
import { provisionGroupSpace } from "./spaces/space-provisioning.js";
import { requireAdministrationSpace } from "./spaces/administration-space.js";
import type { SpaceAttributes } from "./spaces/space-attributes.js";
import { database } from "./database.js";
import { withSystemDatabaseContext } from "./database-context.js";
import type {
  RegisteredGroupType,
  StandardTelegramGroupMessageMode,
  TelegramGroupMessageMode,
} from "./family-access.js";

interface TelegramGroupRegistrationBase {
  /** Включить автоподключение людей без семьи тем же шагом, что и регистрация (команда /family). */
  autoJoinMembers?: boolean;
  /** Только создать: уже существующая строка не меняется и не пересоздаётся, а отказ `AGENT_GROUP_ALREADY_REGISTERED`. */
  createOnly?: boolean;
  space?:SpaceAttributes;
  familyId: string;
  requestedBy: string;
  telegramChatId: string;
  title: string;
  toolAllowlist: string[];
}

export type TelegramGroupRegistration = TelegramGroupRegistrationBase & (
  | {
    messageMode: StandardTelegramGroupMessageMode;
    type: "family_private";
  }
  | {
    messageMode: TelegramGroupMessageMode;
    type: Exclude<RegisteredGroupType, "family_private">;
  }
);

export interface TelegramGroupPolicyUpdate {
  space?:SpaceAttributes;
  familyId: string;
  messageMode: TelegramGroupMessageMode;
  requestedBy: string;
  telegramChatId: string;
  toolAllowlist: string[];
}

export interface TelegramGroupStatus {
  messageMode: TelegramGroupMessageMode;
  telegramChatId: string;
  title: string;
  toolAllowlist: string[];
  type: RegisteredGroupType;
}

export interface TelegramGroupSessionRotation {
  space?:SpaceAttributes;
  familyId: string;
  requestedBy: string;
  telegramChatId: string;
}

export interface TelegramGroupAdministrationRepository {
  listStatuses(input: {
    familyId: string;
    requestedBy: string;
  }): Promise<TelegramGroupStatus[]>;
  registerGroup(input: TelegramGroupRegistration): Promise<{ groupId: string }>;
  removeRegistration(input: {
    space?:SpaceAttributes;
    familyId: string;
    requestedBy: string;
    telegramChatId: string;
  }): Promise<{ groupId: string }>;
  requestGroupSessionRotation(input: TelegramGroupSessionRotation): Promise<{
    groupId: string;
    requestedCanonicalSessions: number;
  }>;
  updatePolicy(input: TelegramGroupPolicyUpdate): Promise<{ groupId: string }>;
}

function openTasksWord(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "незакрытых дел";
  if (last === 1) return "незакрытое дело";
  return last >= 2 && last <= 4 ? "незакрытых дела" : "незакрытых дел";
}

/**
 * A chat registered to someone else. A group without a family (migration 175) has no owner family at all: its
 * administrator turned the bot on with /start, and only /stop in that group frees the chat (15 October 2026 the
 * owner heard «другой семье» instead).
 */
async function registrationConflict(telegramChatId: string): Promise<AppError> {
  // The owner's turn runs in their family's row scope, where a group without a family is invisible (migration
  // 175): only the system scope can tell it from another family's group. The answer says no more than that.
  const familyless = await withSystemDatabaseContext(() => database().query<{ familyless: boolean }>(
    "SELECT family_id IS NULL AS familyless FROM telegram_groups WHERE telegram_chat_id = $1",
    [telegramChatId],
  ));
  return new AppError(
    "AGENT_GROUP_REGISTRATION_CONFLICT",
    familyless.rows[0]?.familyless === true
      ? "В этой группе бот включён без семьи. Чтобы подключить её к семье, администратор группы пишет в ней /stop (это стирает переписку и данные группы), затем подключите её снова"
      : "Группа уже принадлежит другой семье",
  );
}

export const telegramGroupAdministrationRepository: TelegramGroupAdministrationRepository = {
  async listStatuses(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // Keep the current owner membership locked until the family-scoped policy read completes.
      const owner = await client.query(
        `SELECT 1
           FROM family_memberships
          WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
          FOR SHARE`,
        [input.familyId, input.requestedBy],
      );
      if (!owner.rowCount) {
        throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
      }

      // Return the exact persisted configuration; effective external base tools are added by the
      // model-facing tool from the same static catalog used by execution policy.
      const result = await client.query<{
        message_mode: TelegramGroupMessageMode;
        telegram_chat_id: string;
        title: string;
        tool_allowlist: string[];
        type: RegisteredGroupType;
      }>(
        `SELECT telegram_chat_id, title, type, message_mode, tool_allowlist
           FROM telegram_groups
          WHERE family_id = $1
          ORDER BY lower(title), telegram_chat_id`,
        [input.familyId],
      );
      await client.query("COMMIT");
      return result.rows.map((row) => ({
        messageMode: row.message_mode,
        telegramChatId: row.telegram_chat_id,
        title: row.title,
        toolAllowlist: row.tool_allowlist,
        type: row.type,
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async registerGroup(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireAdministrationSpace(client,input.familyId,input.requestedBy,input.space);

      // Lock current ownership so a parked HITL action cannot outlive role revocation.
      const owner = await client.query(
        `SELECT 1
         FROM family_memberships
         WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
         FOR SHARE`,
        [input.familyId, input.requestedBy],
      );
      if (!owner.rowCount) {
        throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
      }

      // Receipt-time media policy and trust-zone replacement share this chat-level lock.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [input.telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED],
      );

      // A type change crosses a trust boundary, so replace the row and cascade all scoped data.
      const existing = await client.query<{ family_id: string; id: string; type: RegisteredGroupType }>(
        `SELECT id, family_id, type
         FROM telegram_groups
         WHERE telegram_chat_id = $1
         FOR UPDATE`,
        [input.telegramChatId],
      );
      const current = existing.rows[0];
      if (current && current.family_id !== input.familyId) throw await registrationConflict(input.telegramChatId);
      if (current && input.createOnly) {
        throw new AppError("AGENT_GROUP_ALREADY_REGISTERED", "Группа уже подключена");
      }
      if (current && current.type !== input.type) {
        await client.query("DELETE FROM telegram_groups WHERE id = $1", [current.id]);
      }

      // A conflicting chat owned by another family is never reassigned through an upsert.
      const result = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups
           (family_id, telegram_chat_id, title, type, tool_allowlist, message_mode, auto_join_members)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (telegram_chat_id)
         DO UPDATE SET title = EXCLUDED.title,
                       type = EXCLUDED.type,
                       tool_allowlist = EXCLUDED.tool_allowlist,
                       message_mode = EXCLUDED.message_mode
         WHERE telegram_groups.family_id = EXCLUDED.family_id
         RETURNING id`,
        [
          input.familyId,
          input.telegramChatId,
          input.title,
          input.type,
          input.toolAllowlist,
          input.messageMode,
          input.autoJoinMembers === true,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw await registrationConflict(input.telegramChatId);
      }

      // Группа без области после включения режима отказана навсегда, поэтому привязка выдаётся
      // тут же: смена типа удалила прежнюю строку вместе с её привязкой каскадом.
      await provisionGroupSpace(client, {
        familyId: input.familyId,
        groupId: row.id,
        type: input.type,
      });
      await client.query("COMMIT");
      return { groupId: row.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async requestGroupSessionRotation(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireAdministrationSpace(client,input.familyId,input.requestedBy,input.space);

      // Authorization is current at mutation time, not inherited from the private session snapshot.
      const owner = await client.query(
        `SELECT 1
           FROM family_memberships
          WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
          FOR SHARE`,
        [input.familyId, input.requestedBy],
      );
      if (!owner.rowCount) {
        throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
      }

      // Serialize exact-chat administration so registration replacement or removal cannot race
      // selection of the trust zone whose canonical sessions are being rotated.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [input.telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED],
      );
      const registered = await client.query<{ id: string }>(
        `SELECT id
           FROM telegram_groups
          WHERE family_id = $1 AND telegram_chat_id = $2
          FOR SHARE`,
        [input.familyId, input.telegramChatId],
      );
      const group = registered.rows[0];
      if (!group) {
        throw new AppError(
          "AGENT_GROUP_NOT_FOUND",
          "Группа с таким telegramChatId не зарегистрирована в вашей семье. " +
            "Вызовите manage_telegram_group ровно с {\"action\":\"status\"}, " +
            "выберите нужную группу и повторите готовый startNewContextInput из результата",
        );
      }

      // Session preparation takes the same group-wide lock before its route lock. Once acquired,
      // the following statement sees every canonical generation committed before this request.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [group.id, SESSION_GROUP_ROTATION_LOCK_HASH_SEED],
      );

      // Canonical rows represent main chat and forum topics. Parked task sessions retain the exact
      // Eve state and requester binding needed to finish or deny their pending operation safely.
      const rotated = await client.query<{ id: string }>(
        `UPDATE conversation_sessions
            SET rotation_requested_at = now(),
                rotation_reason = CASE WHEN rotation_reason IN ('session_failed', 'history_unrecoverable')
                  THEN rotation_reason ELSE 'user_requested' END
          WHERE family_id = $1
            AND group_id = $2
            AND kind = 'canonical'
            AND retired_at IS NULL
          RETURNING id`,
        [input.familyId, group.id],
      );
      await client.query("COMMIT");
      return {
        groupId: group.id,
        requestedCanonicalSessions: rotated.rowCount ?? 0,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async removeRegistration(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireAdministrationSpace(client,input.familyId,input.requestedBy,input.space);

      // Keep authorization and deletion in one transaction to close the HITL revocation race.
      const owner = await client.query(
        `SELECT 1
         FROM family_memberships
         WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
         FOR SHARE`,
        [input.familyId, input.requestedBy],
      );
      if (!owner.rowCount) {
        throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
      }

      // Prevent removal from overtaking an in-flight media trust-zone decision.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [input.telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED],
      );

      // An external group's own tasks go with its registration (`shared_tasks.group_id` cascades): open ones
      // would vanish without a word, so the owner closes or cancels them first (task-capture-repair-plan, stage 5).
      // The row lock first: creating a group task holds the row FOR SHARE, so a task cannot appear between
      // the count and the delete below.
      await client.query(
        "SELECT id FROM telegram_groups WHERE family_id = $1 AND telegram_chat_id = $2 FOR UPDATE",
        [input.familyId, input.telegramChatId],
      );
      const open = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM shared_tasks AS task
           JOIN telegram_groups AS chat ON chat.id = task.group_id
          WHERE chat.family_id = $1 AND chat.telegram_chat_id = $2
            AND task.status NOT IN ('completed', 'declined', 'cancelled')`,
        [input.familyId, input.telegramChatId],
      );
      const openCount = open.rows[0]?.count ?? 0;
      if (openCount > 0) {
        throw new AppError(
          "AGENT_GROUP_HAS_OPEN_TASKS",
          `В этой группе ${openCount} ${openTasksWord(openCount)}: при отключении они удалятся. Сначала закройте или отмените их`,
        );
      }

      // Both group keys remain mandatory so another family's registration is never deleted.
      const result = await client.query<{ id: string }>(
        `DELETE FROM telegram_groups
         WHERE family_id = $1 AND telegram_chat_id = $2
         RETURNING id`,
        [input.familyId, input.telegramChatId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AppError(
          "AGENT_GROUP_NOT_FOUND",
          "Группа не найдена в вашей семье. Проверьте идентификатор Telegram-чата",
        );
      }
      await client.query("COMMIT");
      return { groupId: row.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async updatePolicy(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireAdministrationSpace(client,input.familyId,input.requestedBy,input.space);

      // Recheck current ownership under a shared row lock after HITL and before any side effect.
      const owner = await client.query(
        `SELECT 1
         FROM family_memberships
         WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
         FOR SHARE`,
        [input.familyId, input.requestedBy],
      );
      if (!owner.rowCount) {
        throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
      }

      // Serialize against registration, removal, and receipt-time trust decisions for this chat.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [input.telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED],
      );

      // Lock the existing identity in place; policy updates never replace a trust-zone row.
      const existing = await client.query<{ family_id: string; id: string; type: RegisteredGroupType }>(
        `SELECT id, family_id, type
         FROM telegram_groups
         WHERE telegram_chat_id = $1
         FOR UPDATE`,
        [input.telegramChatId],
      );
      const group = existing.rows[0];
      if (!group || group.family_id !== input.familyId) {
        throw new AppError(
          "AGENT_GROUP_NOT_FOUND",
          "Группа не найдена в вашей семье. Проверьте идентификатор Telegram-чата",
        );
      }
      if (group.type === "family_private") {
        throw new AppError(
          "AGENT_GROUP_POLICY_UPDATE_UNSUPPORTED",
          "Политику инструментов можно изменить только у существующей внешней группы",
        );
      }

      // One statement replaces both policy fields atomically without firing deletion cascades.
      const result = await client.query<{ id: string }>(
        `UPDATE telegram_groups
         SET message_mode = $1, tool_allowlist = $2
         WHERE id = $3
         RETURNING id`,
        [input.messageMode, input.toolAllowlist, group.id],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AppError(
          "AGENT_GROUP_POLICY_UPDATE_FAILED",
          "Не удалось обновить политику группы. Повторите попытку",
        );
      }

      await client.query("COMMIT");
      return { groupId: row.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
