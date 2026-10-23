/**
 * Groups without a family (migrations 175 and 176): turning the bot on and off.
 *
 * Exports:
 * - `familylessGroupRepository.enable`: registers the chat as an external group without a family,
 *   within the installation ceiling, with the default monthly budget.
 * - `familylessGroupRepository.disable`: deletes such a group with everything it holds.
 * - `familylessGroupRepository.budgetGate`: whether this month's spend in the chat still allows a turn,
 *   and whether the chat has yet to hear that it does not.
 *
 * Key constructs:
 * - Both run under the chat-level trust lock that group registration and media acceptance share, so a
 *   family registration and an enable cannot interleave on one chat.
 * - The settings row is locked for update before counting: two enables racing for the last place see
 *   each other's insert, and the ceiling is never exceeded.
 * - A family's group is never touched here: `taken` leaves it to the family's owner.
 * - Deleting the group cascades to its conversation, journal and audit; its sessions are retired by
 *   the existing delete trigger and removed by session retention.
 * - The budget counts the UTC month's calls billed to the chat (migration 177), so it and its one notice
 *   survive /stop and /start. A turn's cost is known only after it ran, so the overrun is bounded by
 *   the turns already running in the chat: one per forum topic queue, not one in total.
 */
import type { PoolClient } from "pg";

import { TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED } from "../config.js";
import { database } from "./database.js";
import { cleanGroupTitle } from "./telegram-group-registration.js";
import { FAMILYLESS_GROUP_TOOL_NAMES } from "./tool-policy/external-group-live-policy.js";

export type FamilylessGroupEnableResult = "already" | "enabled" | "full" | "taken";
export type FamilylessGroupDisableResult = "absent" | "disabled" | "taken";
/** `within`: the turn runs; `notify`: tell the chat once this month; `silent`: already told. */
export type FamilylessGroupBudgetGate = "notify" | "silent" | "within";

/** The first day of the UTC month as `YYYY-MM-01`; SQL turns it into UTC midnight explicitly. */
export function utcMonthStart(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

async function inChatLock<T>(
  telegramChatId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
      [telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED],
    );
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const familylessGroupRepository = {
  async enable(input: {
    enabledByTelegramUserId: string;
    telegramChatId: string;
    telegramChatType: "group" | "supergroup";
    title: string;
  }): Promise<FamilylessGroupEnableResult> {
    return await inChatLock(input.telegramChatId, async (client) => {
      const existing = await client.query<{ family_id: string | null }>(
        "SELECT family_id FROM telegram_groups WHERE telegram_chat_id = $1 FOR UPDATE",
        [input.telegramChatId],
      );
      if (existing.rows[0]) return existing.rows[0].family_id === null ? "already" : "taken";
      const settings = await client.query<{ default_monthly_budget_usd: string; max_groups: number }>(
        "SELECT max_groups, default_monthly_budget_usd FROM familyless_group_settings FOR UPDATE",
      );
      const limits = settings.rows[0];
      if (!limits) {
        throw new Error("AGENT_FAMILYLESS_GROUP_SETTINGS_MISSING: Нет настроек групп без семьи");
      }
      const count = await client.query<{ groups: number }>(
        "SELECT count(*)::integer AS groups FROM telegram_groups WHERE family_id IS NULL",
      );
      if ((count.rows[0]?.groups ?? 0) >= limits.max_groups) return "full";
      await client.query(
        `INSERT INTO telegram_groups
           (family_id, telegram_chat_id, telegram_chat_type, title, type, message_mode, tool_allowlist,
            enabled_by_telegram_user_id, monthly_budget_usd)
         VALUES (NULL, $1, $2, $3, 'external', 'addressed_only', $4, $5, $6)`,
        [
          input.telegramChatId,
          input.telegramChatType,
          cleanGroupTitle(input.title, "Группа"),
          [...FAMILYLESS_GROUP_TOOL_NAMES],
          input.enabledByTelegramUserId,
          limits.default_monthly_budget_usd,
        ],
      );
      return "enabled";
    });
  },

  async disable(input: { telegramChatId: string }): Promise<FamilylessGroupDisableResult> {
    return await inChatLock(input.telegramChatId, async (client) => {
      const existing = await client.query<{ family_id: string | null; id: string }>(
        "SELECT id, family_id FROM telegram_groups WHERE telegram_chat_id = $1 FOR UPDATE",
        [input.telegramChatId],
      );
      const group = existing.rows[0];
      if (!group) return "absent";
      if (group.family_id !== null) return "taken";
      await client.query("DELETE FROM telegram_groups WHERE id = $1", [group.id]);
      return "disabled";
    });
  },

  async budgetGate(input: { groupId: string; now: Date; telegramChatId: string }): Promise<FamilylessGroupBudgetGate> {
    const month = utcMonthStart(input.now);
    // A call the price table cannot price is no free call: it closes the budget until the table knows it.
    const spend = await database().query<{ exhausted: boolean; unpriced: number }>(
      `SELECT COALESCE(sum(e.cost_usd), 0) >= g.monthly_budget_usd OR count(e.id) FILTER (WHERE e.cost_usd IS NULL) > 0
                AS exhausted,
              count(e.id) FILTER (WHERE e.cost_usd IS NULL)::integer AS unpriced
         FROM telegram_groups g
         LEFT JOIN model_usage_events e
           ON e.familyless_chat_id = $2 AND e.created_at >= ($3::date)::timestamp AT TIME ZONE 'UTC'
        WHERE g.id = $1 AND g.family_id IS NULL
        GROUP BY g.monthly_budget_usd`,
      [input.groupId, input.telegramChatId, month],
    );
    const row = spend.rows[0];
    if (!row) throw new Error("AGENT_FAMILYLESS_GROUP_MISSING: Группа без семьи не найдена");
    if (!row.exhausted) return "within";
    const claimed = await database().query(
      `INSERT INTO familyless_group_budget_notices (telegram_chat_id, month) VALUES ($1, $2::date)
       ON CONFLICT DO NOTHING`,
      [input.telegramChatId, month],
    );
    console.info(JSON.stringify({
      chatId: input.telegramChatId,
      code: "AGENT_FAMILYLESS_GROUP_BUDGET_EXHAUSTED",
      notified: claimed.rowCount === 1,
      unpricedCalls: row.unpriced,
    }));
    return claimed.rowCount === 1 ? "notify" : "silent";
  },
};
