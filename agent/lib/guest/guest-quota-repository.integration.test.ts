/**
 * Daily guest-answer ceiling on the real schema (migration 173).
 *
 * Constructs covered:
 * - Answers count per caller until the caller's ceiling, then `caller_limit`.
 * - The installation ceiling refuses a new caller with `daily_limit` once the day's total is reached.
 * - Rows of another day neither count today nor survive the retention window.
 * - A released slot is counted again; the last slot of the day removes the row (`answers > 0`).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { guestQuotaRepository } from "./guest-quota-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

(enabled ? describe : describe.skip)("guest quota repository", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_guest_usage");
  });
  afterAll(async () => {
    await closeDatabase();
  });

  it("counts each caller up to the caller ceiling", async () => {
    const limits = { perCallerPerDay: 2, perDay: 100 };

    expect(await guestQuotaRepository.claim("101", limits)).toBe("allowed");
    expect(await guestQuotaRepository.claim("101", limits)).toBe("allowed");
    expect(await guestQuotaRepository.claim("101", limits)).toBe("caller_limit");
    expect(await guestQuotaRepository.claim("202", limits)).toBe("allowed");

    const rows = await database().query<{ answers: number; telegram_user_id: string }>(
      "SELECT telegram_user_id::text, answers FROM telegram_guest_usage ORDER BY telegram_user_id",
    );
    expect(rows.rows).toEqual([{ answers: 2, telegram_user_id: "101" }, { answers: 1, telegram_user_id: "202" }]);
  });

  it("refuses a new caller once the installation total for the day is reached", async () => {
    const limits = { perCallerPerDay: 5, perDay: 3 };
    for (let index = 0; index < 3; index += 1) {
      expect(await guestQuotaRepository.claim("101", limits)).toBe("allowed");
    }

    expect(await guestQuotaRepository.claim("202", limits)).toBe("daily_limit");
    expect(await guestQuotaRepository.claim("101", limits)).toBe("daily_limit");
  });

  it("returns a released slot and removes the row with its last slot", async () => {
    const limits = { perCallerPerDay: 2, perDay: 100 };
    await guestQuotaRepository.claim("101", limits);
    await guestQuotaRepository.claim("101", limits);

    await guestQuotaRepository.release("101");
    expect(await guestQuotaRepository.claim("101", limits)).toBe("allowed");
    await guestQuotaRepository.release("101");
    await guestQuotaRepository.release("101");
    await guestQuotaRepository.release("101");

    const rows = await database().query("SELECT 1 FROM telegram_guest_usage WHERE telegram_user_id = 101");
    expect(rows.rowCount).toBe(0);
  });

  it("ignores yesterday in today's totals and drops rows past the retention window", async () => {
    await database().query(
      `INSERT INTO telegram_guest_usage (usage_day, telegram_user_id, answers)
       VALUES (current_date - 1, 101, 50), (current_date - 31, 303, 1)`,
    );

    expect(await guestQuotaRepository.claim("101", { perCallerPerDay: 2, perDay: 10 })).toBe("allowed");

    const days = await database().query<{ telegram_user_id: string }>(
      "SELECT telegram_user_id::text FROM telegram_guest_usage ORDER BY usage_day",
    );
    expect(days.rows.map((row) => row.telegram_user_id)).toEqual(["101", "101"]);
  });
});
