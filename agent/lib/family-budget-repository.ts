/**
 * Monthly model budget of a family (migration 181).
 *
 * Exports:
 * - `FamilyBudgetGate`: whether a family turn may go on, and whether this is the month's one notice.
 * - `FAMILY_BUDGET_NOTICE`: what the chat hears once a month when the budget is used up.
 * - `familyBudgetRepository`: records the cost of a family's call, decides the gate before a turn, says without
 *   side effects whether the model is available,
 *   sums the month of the families with a budget for the operator digest, purges old rows.
 * - `formatFamilySpend`: that digest line, families by ordinal only (`other-families-health.ts`).
 *
 * Key constructs:
 * - The family comes only from the verified session auth (`agent/agent.ts` names it to the transport);
 *   the model never chooses whose budget pays.
 * - The budget counts the UTC month's priced calls of the family's turns. A call the price table cannot
 *   price does not close the budget (unlike a group without a family): a family has an owner the operator
 *   knows, and the digest already shows unpriced calls.
 * - NULL budget is no budget: the families that were here before the beta keep none.
 * - Writes and the digest run in system scope: spend is installation accounting, recorded from the
 *   transport whatever scope the call came from.
 */
import { FAMILYLESS_USAGE_RETENTION_DAYS, MODEL_USAGE_PURGE_BATCH_SIZE } from "../config.js";
import { database } from "./database.js";
import { withSystemDatabaseContext } from "./database-context.js";
import { utcMonthStart } from "./familyless-group-repository.js";

export type FamilyBudgetGate = "notify" | "silent" | "within";

// Past the budget only the model is silent (решение владельца 20 октября 2026): reminders, the morning summary, task
// buttons and the Mini App do not call it and keep working, so the notice says so instead of «я молчу».
export const FAMILY_BUDGET_NOTICE =
  "В этом месяце лимит расходов вашей семьи на модель исчерпан: до 1-го числа я не отвечаю на сообщения. " +
  "Напоминания, утренняя сводка, кнопки дел и приложение работают как обычно.";

export interface FamilyMonthSpend {
  readonly budgetUsd: number;
  /** The family's place in creation order, the operator's being the first: the digest names no family. */
  readonly familyOrdinal: number;
  readonly spentUsd: number;
}

/** The family's spend this UTC month and whether it reached the budget; no budget is never exhausted. */
function monthSpendOf(familyId: string, month: string) {
  return withSystemDatabaseContext(() => database().query<{ exhausted: boolean | null; spent: string }>(
    `SELECT f.monthly_model_budget_usd IS NOT NULL AND COALESCE(sum(s.cost_usd), 0) >= f.monthly_model_budget_usd AS exhausted,
            COALESCE(sum(s.cost_usd), 0)::text AS spent
       FROM families f
       LEFT JOIN family_model_spend s
         ON s.family_id = f.id AND s.created_at >= ($2::date)::timestamp AT TIME ZONE 'UTC'
      WHERE f.id = $1
      GROUP BY f.monthly_model_budget_usd`,
    [familyId, month],
  ));
}

export const familyBudgetRepository = {
  async recordSpend(input: { at: Date; costUsd: number | null; familyId: string }): Promise<void> {
    await withSystemDatabaseContext(() => database().query(
      "INSERT INTO family_model_spend (family_id, created_at, cost_usd) VALUES ($1, $2, $3)",
      [input.familyId, input.at, input.costUsd],
    ));
  },

  async budgetGate(input: { familyId: string; now: Date }): Promise<FamilyBudgetGate> {
    const month = utcMonthStart(input.now);
    const spend = await monthSpendOf(input.familyId, month);
    if (spend.rows[0]?.exhausted !== true) return "within";
    const claimed = await withSystemDatabaseContext(() => database().query(
      "INSERT INTO family_budget_notices (family_id, month) VALUES ($1, $2::date) ON CONFLICT DO NOTHING",
      [input.familyId, month],
    ));
    console.info(JSON.stringify({
      code: "AGENT_FAMILY_BUDGET_EXHAUSTED",
      familyId: input.familyId,
      notified: claimed.rowCount === 1,
      spentUsd: Number(spend.rows[0].spent),
    }));
    return claimed.rowCount === 1 ? "notify" : "silent";
  },

  /**
   * Whether a family turn could use the model now, without spending the month's one notice: a button that
   * starts a turn («Помоги начать») is not shown to a family whose model is silent until the 1st.
   */
  async modelAvailable(input: { familyId: string; now: Date }): Promise<boolean> {
    const spend = await monthSpendOf(input.familyId, utcMonthStart(input.now));
    return spend.rows[0]?.exhausted !== true;
  },

  /** Every family with a budget and spend this UTC month, most spent first. */
  async monthSpend(now: Date): Promise<FamilyMonthSpend[]> {
    const result = await withSystemDatabaseContext(() => database().query<{ budget: string; ordinal: string; spent: string }>(
      `SELECT f.ordinal::text, f.monthly_model_budget_usd::text AS budget, sum(s.cost_usd)::text AS spent
         FROM (SELECT id, monthly_model_budget_usd, row_number() OVER (ORDER BY created_at, id) AS ordinal FROM families) f
         JOIN family_model_spend s
           ON s.family_id = f.id AND s.created_at >= ($1::date)::timestamp AT TIME ZONE 'UTC' AND s.cost_usd IS NOT NULL
        WHERE f.monthly_model_budget_usd IS NOT NULL
        GROUP BY f.ordinal, f.monthly_model_budget_usd
        ORDER BY sum(s.cost_usd) DESC, f.ordinal
        LIMIT 50`,
      [utcMonthStart(now)],
    ));
    return result.rows.map((row) => ({
      budgetUsd: Number(row.budget), familyOrdinal: Number(row.ordinal), spentUsd: Number(row.spent),
    }));
  },

  async purgeExpired(now: Date): Promise<number> {
    return withSystemDatabaseContext(async () => {
      const result = await database().query(
        `WITH expired AS (
           SELECT id FROM family_model_spend
            WHERE created_at < $1::timestamptz - ($2::integer * interval '1 day')
            ORDER BY created_at LIMIT $3::integer
         )
         DELETE FROM family_model_spend spend USING expired WHERE spend.id = expired.id`,
        [now, FAMILYLESS_USAGE_RETENTION_DAYS, MODEL_USAGE_PURGE_BATCH_SIZE],
      );
      await database().query(
        `DELETE FROM family_budget_notices
          WHERE month < date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC')::date - interval '1 month'`,
        [now],
      );
      return result.rowCount ?? 0;
    });
  },
};

/** «Расход семей с лимитом за месяц: семья 3 — 4.10 из 5.00 $ (исчерпан), семья 2 — 0.40 из 5.00 $.» */
export function formatFamilySpend(rows: readonly FamilyMonthSpend[]): string | null {
  if (rows.length === 0) return null;
  const parts = rows.map((row) => `семья ${row.familyOrdinal} — ${row.spentUsd.toFixed(2)} из ${row.budgetUsd.toFixed(2)} $` +
    (row.spentUsd >= row.budgetUsd ? " (исчерпан)" : ""));
  return `Расход семей с лимитом за месяц: ${parts.join(", ")}.`;
}
