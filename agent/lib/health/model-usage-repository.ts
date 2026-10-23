/**
 * Durable per-call model usage.
 *
 * Export:
 * - `modelUsageRepository`: records provider usage, summarises a window, purges old rows.
 * - `recordModelUsage`: fire-and-forget writer for the production transport.
 *
 * Key constructs:
 * - Written from the transport, the only place that sees DeepSeek's cache split. The row has no
 *   session or family: a call is billed whether or not a turn owns it, and one installation serves
 *   one family (as the ingress counters in the digest already assume).
 * - A failed write is logged and dropped: spend accounting must never fail a model call.
 * - A call of a group without a family carries its Telegram chat (migration 177); such rows live
 *   `FAMILYLESS_USAGE_RETENTION_DAYS`, longer than a UTC month, so the group's budget always sees it whole.
 * - A call of a family's turn also leaves its cost in the family's own spend (migration 181,
 *   `family-budget-repository.ts`); this table stays without a family.
 */
import {
  FAMILYLESS_USAGE_RETENTION_DAYS,
  MODEL_USAGE_PURGE_BATCH_SIZE,
  MODEL_USAGE_RETENTION_DAYS,
} from "../../config.js";
import { database } from "../database.js";
import { familyBudgetRepository } from "../family-budget-repository.js";
import { modelCallCostUsd, type ModelSpendSummary } from "./model-spend.js";

export interface ModelUsageRecord {
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly familylessChatId?: string | null;
  readonly familyId?: string | null;
  readonly modelId: string;
  readonly outputTokens: number;
  readonly webSearchCalls: number;
}

export const modelUsageRepository = {
  async record(usage: ModelUsageRecord, at: Date): Promise<void> {
    const cost = modelCallCostUsd(usage.modelId, usage, at);
    await database().query(
      `INSERT INTO model_usage_events
         (model_id, cache_hit_tokens, cache_miss_tokens, output_tokens, web_search_calls, cost_usd, created_at,
          familyless_chat_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [usage.modelId, usage.cacheHitTokens, usage.cacheMissTokens, usage.outputTokens, usage.webSearchCalls,
        cost, at, usage.familylessChatId ?? null],
    );
    if (usage.familyId) await familyBudgetRepository.recordSpend({ at, costUsd: cost, familyId: usage.familyId });
  },

  async summary(windowStart: Date, now: Date): Promise<ModelSpendSummary> {
    const result = await database().query<{
      cache_hit: string; cache_miss: string; calls: string; cost: string; output: string; unpriced: string; searches: string;
    }>(
      `SELECT count(*)::text AS calls,
              COALESCE(sum(cache_hit_tokens), 0)::text AS cache_hit,
              COALESCE(sum(cache_miss_tokens), 0)::text AS cache_miss,
              COALESCE(sum(output_tokens), 0)::text AS output,
              COALESCE(sum(web_search_calls), 0)::text AS searches,
              COALESCE(sum(cost_usd), 0)::text AS cost,
              count(*) FILTER (WHERE cost_usd IS NULL)::text AS unpriced
         FROM model_usage_events
        WHERE created_at >= $1 AND created_at <= $2`,
      [windowStart, now],
    );
    const row = result.rows[0]!;
    return {
      cacheHitTokens: Number(row.cache_hit),
      cacheMissTokens: Number(row.cache_miss),
      calls: Number(row.calls),
      costUsd: Number(row.cost),
      outputTokens: Number(row.output),
      unpricedCalls: Number(row.unpriced),
      webSearchCalls: Number(row.searches),
    };
  },

  async purgeExpired(now: Date): Promise<number> {
    const result = await database().query(
      `WITH expired AS (
         SELECT id FROM model_usage_events
          WHERE created_at < $1::timestamptz - ($2::integer * interval '1 day')
            AND (familyless_chat_id IS NULL OR created_at < $1::timestamptz - ($4::integer * interval '1 day'))
          ORDER BY created_at LIMIT $3::integer
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM model_usage_events event USING expired WHERE event.id = expired.id`,
      [now, MODEL_USAGE_RETENTION_DAYS, MODEL_USAGE_PURGE_BATCH_SIZE, FAMILYLESS_USAGE_RETENTION_DAYS],
    );
    // A budget notice matters only for its own month; the previous one is kept for the month boundary.
    await database().query(
      `DELETE FROM familyless_group_budget_notices
        WHERE month < date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC')::date - interval '1 month'`,
      [now],
    );
    return result.rowCount ?? 0;
  },
};

export function recordModelUsage(usage: ModelUsageRecord): void {
  void modelUsageRepository.record(usage, new Date()).catch((error: unknown) => {
    console.error(JSON.stringify({
      code: "AGENT_MODEL_USAGE_RECORD_FAILED",
      error: error instanceof Error ? error.message : String(error),
      modelId: usage.modelId,
    }));
  });
}

export async function purgeExpiredModelUsage(now: Date): Promise<number> {
  const [usage] = await Promise.all([modelUsageRepository.purgeExpired(now), familyBudgetRepository.purgeExpired(now)]);
  return usage;
}
