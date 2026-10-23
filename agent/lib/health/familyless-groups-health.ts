/**
 * What the operator hears about groups without a family (migrations 175–177).
 *
 * Exports:
 * - `readFamilylessGroupsHealth`: how many such groups exist against the ceiling, this UTC month's
 *   spend billed to them and how many used up their budget.
 * - `formatFamilylessGroups`: the digest line; nothing while there are no such groups.
 *
 * Key construct:
 * - Only counters and dollars reach the operator's private chat: no title, chat or person of a group.
 *   The month's spend is counted by chat, like the budget itself, so a group that was turned off this
 *   month still shows in the dollars it cost.
 */
import { database } from "../database.js";
import { withSystemDatabaseContext } from "../database-context.js";
import { utcMonthStart } from "../familyless-group-repository.js";

export interface FamilylessGroupsHealth {
  exhausted: number;
  groups: number;
  maxGroups: number;
  monthSpendUsd: number;
}

export async function readFamilylessGroupsHealth(now: Date): Promise<FamilylessGroupsHealth> {
  const month = utcMonthStart(now);
  const result = await withSystemDatabaseContext(() => database().query<{
    exhausted: number; groups: number; max_groups: number; spend: string;
  }>(
    `WITH spend AS (
       SELECT familyless_chat_id AS chat_id, sum(cost_usd) AS usd
         FROM model_usage_events
        WHERE familyless_chat_id IS NOT NULL AND created_at >= ($1::date)::timestamp AT TIME ZONE 'UTC'
        GROUP BY familyless_chat_id
     )
     SELECT (SELECT count(*) FROM telegram_groups WHERE family_id IS NULL)::int AS groups,
            (SELECT max_groups FROM familyless_group_settings) AS max_groups,
            COALESCE((SELECT sum(usd) FROM spend), 0)::text AS spend,
            (SELECT count(*) FROM telegram_groups g JOIN spend s ON s.chat_id = g.telegram_chat_id
              WHERE g.family_id IS NULL AND s.usd >= g.monthly_budget_usd)::int AS exhausted`,
    [month],
  ));
  const row = result.rows[0]!;
  return { exhausted: row.exhausted, groups: row.groups, maxGroups: row.max_groups, monthSpendUsd: Number(row.spend) };
}

export function formatFamilylessGroups(health: FamilylessGroupsHealth): string | null {
  if (health.groups === 0 && health.monthSpendUsd === 0) return null;
  return `Группы без семьи: ${health.groups}/${health.maxGroups}, $${health.monthSpendUsd.toFixed(2)} за месяц` +
    (health.exhausted > 0 ? `, исчерпали бюджет ${health.exhausted}.` : ".");
}
