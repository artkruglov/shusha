/**
 * Deleting a person or a whole family at their own request (`/delete_me`, `/delete_family`).
 *
 * Exports:
 * - `familyDeletionRepository`: `deleteMember` for a member who leaves, `deleteFamily` for an owner who closes the
 *   family; each one transaction, rights re-read live inside it.
 *
 * Key constructs:
 * - This is the person's own request to erase, so rows are removed, not soft-deleted: memory, tasks, sessions and
 *   files go with the family (every table with `family_id` cascades from `families`) or with the person (`users`).
 * - A member who leaves gives back their shared tasks as the owner's `removeMember` does, loses their personal tasks,
 *   feedback and the records about them, and their `users` row goes. Columns that merely name the person as an
 *   actor (an audit actor, a family memory's author) are `ON DELETE SET NULL`: the family's records stay, unattributed.
 * - The owner cannot leave this way: the family would be left without one. Closing it deletes the family and then
 *   every member who belongs to no other family.
 * - Eve keeps its own history in the workflow schema, found through `conversation_sessions`: the Eve session ids
 *   are queued in `erased_eve_sessions` before the cascade, and session retention deletes them physically.
 * - The raw Telegram updates of the erased private chats (and of the family's groups when the family goes) are
 *   deleted too, except the one being processed, which completes and leaves with the usual retention.
 * - Anything the schema refuses rolls the whole transaction back: nothing is deleted halfway.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { withSystemDatabaseContext } from "./database-context.js";
import { lockFamilyMembers } from "./family-repository.js";

/** Records whose subject is the person, which the schema will not let outlive them. */
const SUBJECT_TABLES = ["memory_thread_discovery_jobs", "confirmed_outcomes", "memory_threads"] as const;

/** Eve's history of these application sessions goes after the transaction, by session retention. */
async function queueEveSessions(client: PoolClient, where: string, values: unknown[]): Promise<void> {
  await client.query(
    `INSERT INTO erased_eve_sessions (eve_session_id)
     SELECT DISTINCT eve_session_id FROM conversation_sessions WHERE eve_session_id IS NOT NULL AND (${where})
     ON CONFLICT DO NOTHING`,
    values,
  );
}

/** Raw updates of these chats; the one being processed now is not finished and stays for its own retention. */
async function deleteIngressUpdates(client: PoolClient, chatIds: readonly string[]): Promise<void> {
  if (chatIds.length === 0) return;
  await client.query(
    `DELETE FROM telegram_ingress_updates
      WHERE status IN ('completed', 'failed')
        AND split_part(ingress_continuation_key, ':', 1) = ANY($1::text[])`,
    [chatIds],
  );
}

async function deleteUsers(client: PoolClient, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  // The endorsement is a pair (migration 051): a family memory they endorsed keeps neither half.
  await client.query(
    "UPDATE memory_items_all SET endorsed_by_user_id = NULL, endorsed_at = NULL WHERE endorsed_by_user_id = ANY($1::uuid[])",
    [userIds],
  );
  await queueEveSessions(client, "owner_user_id = ANY($1::uuid[]) AND scope = 'personal'", [userIds]);
  // Their private sessions go now rather than as retired rows waiting out the usual 90 days.
  await client.query("DELETE FROM conversation_sessions WHERE owner_user_id = ANY($1::uuid[]) AND scope = 'personal'", [userIds]);
  for (const table of SUBJECT_TABLES) {
    await client.query(`DELETE FROM ${table} WHERE subject_user_id = ANY($1::uuid[])`, [userIds]);
  }
  await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  // Erasing crosses every table of the family and the person: installation-wide work.
  return withSystemDatabaseContext(async () => {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

export const familyDeletionRepository = {
  async deleteMember(input: { familyId: string; userId: string }): Promise<void> {
    await inTransaction(async (client) => {
      await lockFamilyMembers(client, input.familyId);
      // The rows a turn's authorization reads FOR SHARE: a task being created right now waits for this
      // transaction and then finds no member, instead of committing a personal task after its cleanup.
      const member = await client.query<{ role: string; telegram_user_id: string }>(
        `SELECT membership.role, person.telegram_user_id FROM family_memberships membership
           JOIN users person ON person.id = membership.user_id
          WHERE membership.family_id = $1 AND membership.user_id = $2
          FOR UPDATE OF membership, person`,
        [input.familyId, input.userId],
      );
      const row = member.rows[0];
      if (!row) throw new AppError("AGENT_ACCESS_DENIED", "Вы уже не в семье");
      if (row.role === "owner" || row.role === "recovery_owner") {
        throw new AppError(
          "AGENT_FAMILY_OWNER_CANNOT_LEAVE",
          "Владелец не может уйти сам: семья останется без владельца. Удалить семью целиком: /delete_family",
        );
      }
      // Shared tasks given to them are free again, as when the owner removes a member; their transfers end.
      await client.query(
        `UPDATE shared_tasks
            SET status = CASE WHEN kind = 'task' THEN 'open' ELSE 'cancelled' END,
                assignee_telegram_id = NULL, pending_assignee_telegram_id = NULL, transfer_requested_at = NULL,
                version = version + 1, updated_at = now()
          WHERE family_id = $1 AND scope <> 'personal' AND assignee_telegram_id = $2 AND status IN ('proposed', 'accepted')`,
        [input.familyId, row.telegram_user_id],
      );
      await client.query(
        `UPDATE shared_tasks SET pending_assignee_telegram_id = NULL, transfer_requested_at = NULL, version = version + 1, updated_at = now()
          WHERE family_id = $1 AND pending_assignee_telegram_id = $2`,
        [input.familyId, row.telegram_user_id],
      );
      await client.query(
        "DELETE FROM shared_tasks WHERE family_id = $1 AND scope = 'personal' AND creator_telegram_id = $2",
        [input.familyId, row.telegram_user_id],
      );
      // Their own plans on the family's tasks, keyed by the Telegram id, would wait for them to come back.
      await client.query(
        `DELETE FROM shared_task_plans plan USING shared_tasks task
          WHERE plan.task_id = task.id AND task.family_id = $1 AND plan.telegram_user_id = $2`,
        [input.familyId, row.telegram_user_id],
      );
      // Care areas they held are open again; one offered to them is no longer offered.
      await client.query(
        `UPDATE care_areas SET
           owner_telegram_id = NULLIF(owner_telegram_id, $2),
           pending_owner_telegram_id = NULLIF(pending_owner_telegram_id, $2),
           proposed_at = CASE WHEN pending_owner_telegram_id = $2 THEN NULL ELSE proposed_at END,
           status = CASE
             WHEN status = 'retired' THEN 'retired'
             WHEN NULLIF(pending_owner_telegram_id, $2) IS NOT NULL THEN 'proposed'
             WHEN NULLIF(owner_telegram_id, $2) IS NOT NULL THEN 'accepted'
             ELSE 'open' END,
           version = version + 1, updated_at = now()
         WHERE family_id = $1 AND (owner_telegram_id = $2 OR pending_owner_telegram_id = $2)`,
        [input.familyId, row.telegram_user_id],
      );
      await client.query("DELETE FROM shared_task_participants WHERE family_id = $1 AND telegram_user_id = $2",
        [input.familyId, row.telegram_user_id]);
      await client.query("DELETE FROM feedback_messages WHERE telegram_user_id = $1", [row.telegram_user_id]);
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, metadata)
         VALUES ($1, NULL, 'family.member_deleted_self', '{}'::jsonb)`,
        [input.familyId],
      );
      await deleteUsers(client, [input.userId]);
      // A private chat's id is the person's Telegram id.
      await deleteIngressUpdates(client, [row.telegram_user_id]);
    });
  },

  async deleteFamily(input: { familyId: string; ownerUserId: string }): Promise<{ members: number }> {
    return inTransaction(async (client) => {
      await lockFamilyMembers(client, input.familyId);
      const owner = await client.query(
        "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2 AND role = 'owner'",
        [input.familyId, input.ownerUserId],
      );
      if (owner.rowCount !== 1) throw new AppError("AGENT_ACCESS_DENIED", "Удалить семью может только её владелец");
      const members = await client.query<{ user_id: string }>(
        `SELECT membership.user_id FROM family_memberships membership
          WHERE membership.family_id = $1
            AND NOT EXISTS (SELECT 1 FROM family_memberships other
                             WHERE other.user_id = membership.user_id AND other.family_id <> $1)`,
        [input.familyId],
      );
      const chats = await client.query<{ chat_id: string }>(
        `SELECT person.telegram_user_id AS chat_id FROM family_memberships membership
           JOIN users person ON person.id = membership.user_id
          WHERE membership.family_id = $1 AND person.telegram_user_id IS NOT NULL
         UNION SELECT telegram_chat_id FROM telegram_groups WHERE family_id = $1`,
        [input.familyId],
      );
      await queueEveSessions(client, "family_id = $1", [input.familyId]);
      await client.query("DELETE FROM families WHERE id = $1", [input.familyId]);
      await deleteUsers(client, members.rows.map((row) => row.user_id));
      await deleteIngressUpdates(client, chats.rows.map((row) => row.chat_id));
      return { members: members.rowCount ?? 0 };
    });
  },
};
