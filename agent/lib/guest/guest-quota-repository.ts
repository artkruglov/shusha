/**
 * Daily ceiling of guest-mode answers (migration 173).
 *
 * Exports:
 * - `GuestQuotaDecision`: whether one more answer fits for this caller today.
 * - `guestQuotaRepository`: counts an answer atomically, or names the ceiling that refused it; returns
 *   the slot of an answer that failed before it was sent.
 *
 * The installation total is read in the same statement as the caller's increment, so two parallel
 * callers can pass the total by one or two answers; the ceiling bounds cost, it is not an invoice.
 * The day is the UTC day whatever timezone the database session uses.
 */
import { database } from "../database.js";

export type GuestQuotaDecision = "allowed" | "caller_limit" | "daily_limit";

export interface GuestQuotaLimits {
  readonly perCallerPerDay: number;
  readonly perDay: number;
}

const GUEST_USAGE_RETENTION_DAYS = 30;

export const guestQuotaRepository = {
  async claim(telegramUserId: string, limits: GuestQuotaLimits): Promise<GuestQuotaDecision> {
    const result = await database().query<{ answers: number | null; total: string }>(
      `WITH total AS (
         SELECT COALESCE(sum(answers), 0) AS answered
         FROM telegram_guest_usage
         WHERE usage_day = (now() AT TIME ZONE 'UTC')::date
       ), counted AS (
         INSERT INTO telegram_guest_usage AS usage (usage_day, telegram_user_id, answers)
         SELECT (now() AT TIME ZONE 'UTC')::date, $1::bigint, 1 FROM total WHERE total.answered < $3
         ON CONFLICT (usage_day, telegram_user_id)
           DO UPDATE SET answers = usage.answers + 1
           WHERE usage.answers < $2
         RETURNING answers
       )
       SELECT (SELECT answered FROM total)::text AS total, (SELECT answers FROM counted) AS answers`,
      [telegramUserId, limits.perCallerPerDay, limits.perDay],
    );
    await database().query(
      "DELETE FROM telegram_guest_usage WHERE usage_day < (now() AT TIME ZONE 'UTC')::date - $1::integer",
      [GUEST_USAGE_RETENTION_DAYS],
    );
    const row = result.rows[0]!;
    if (row.answers !== null) return "allowed";
    return Number(row.total) >= limits.perDay ? "daily_limit" : "caller_limit";
  },

  async release(telegramUserId: string): Promise<void> {
    // `answers > 0` is a table constraint: the last slot of the day is deleted, not set to zero.
    await database().query(
      `WITH released AS (
         DELETE FROM telegram_guest_usage
         WHERE usage_day = (now() AT TIME ZONE 'UTC')::date AND telegram_user_id = $1::bigint AND answers = 1
       )
       UPDATE telegram_guest_usage SET answers = answers - 1
       WHERE usage_day = (now() AT TIME ZONE 'UTC')::date AND telegram_user_id = $1::bigint AND answers > 1`,
      [telegramUserId],
    );
  },
};
