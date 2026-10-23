/**
 * The operator's digest line about groups without a family.
 *
 * Constructs covered:
 * - Groups are counted against the ceiling, the month's spend is summed by chat (a group turned off
 *   this month still counts), and a group past its budget is counted as exhausted.
 * - No line at all while there are no such groups and no spend.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { formatFamilylessGroups, readFamilylessGroupsHealth } from "./familyless-groups-health.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);

(enabled ? describe : describe.skip)("familyless groups health", () => {
  beforeEach(async () => {
    await database().query("DELETE FROM telegram_groups WHERE family_id IS NULL");
    await database().query("DELETE FROM model_usage_events WHERE familyless_chat_id IS NOT NULL");
  });
  afterAll(closeDatabase);

  it("counts groups, the month's spend by chat and the exhausted ones", async () => {
    const now = new Date();
    expect(formatFamilylessGroups(await readFamilylessGroupsHealth(now))).toBeNull();
    for (const [chat, budget] of [["-100950001", 1], ["-100950002", 3]] as const) {
      await database().query(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode,
           enabled_by_telegram_user_id, monthly_budget_usd)
         VALUES (NULL, $1, 'g', 'external', 'addressed_only', '950100', $2)`,
        [chat, budget],
      );
    }
    for (const [chat, cost] of [["-100950001", 1.2], ["-100950002", 0.5], ["-100950009", 0.3]] as const) {
      await database().query(
        `INSERT INTO model_usage_events
           (model_id, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_usd, familyless_chat_id)
         VALUES ('deepseek-v4-flash', 0, 0, 0, $1, $2)`,
        [cost, chat],
      );
    }
    const health = await readFamilylessGroupsHealth(now);
    expect(health).toMatchObject({ exhausted: 1, groups: 2, monthSpendUsd: 2 });
    expect(formatFamilylessGroups(health)).toBe(
      `Группы без семьи: 2/${health.maxGroups}, $2.00 за месяц, исчерпали бюджет 1.`);
  });
});
