/**
 * A family's monthly model budget on the real schema (migration 181).
 *
 * Constructs covered:
 * - A family without a budget (the families from before the beta) is never stopped.
 * - A new family gets five dollars; past it the first turn hears the notice and the next ones are silent,
 *   and the next UTC month starts again.
 * - A call recorded through the usage recorder counts for its family only, and an unpriced one does not
 *   close the budget.
 * - The operator digest lists the month's spend of families with a budget, by ordinal only.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { familyBudgetRepository, formatFamilySpend } from "./family-budget-repository.js";
import { modelUsageRepository } from "./health/model-usage-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

const NOW = new Date("2026-10-18T12:00:00Z");

async function family(name: string, budget?: number | null): Promise<string> {
  const row = budget === undefined
    ? await database().query<{ id: string }>("INSERT INTO families(name) VALUES($1) RETURNING id", [name])
    : await database().query<{ id: string }>(
      "INSERT INTO families(name, monthly_model_budget_usd) VALUES($1, $2) RETURNING id", [name, budget]);
  return row.rows[0]!.id;
}

const spend = (familyId: string, costUsd: number | null, at = NOW) =>
  familyBudgetRepository.recordSpend({ at, costUsd, familyId });

(enabled ? describe : describe.skip)("family model budget", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families, users CASCADE");
  });
  afterAll(closeDatabase);

  it("never stops a family without a budget", async () => {
    const old = await family("Первая", null);
    await spend(old, 100);
    expect(await familyBudgetRepository.budgetGate({ familyId: old, now: NOW })).toBe("within");
  });

  it("gives a new family five dollars, tells it once when they are spent, and starts again next month", async () => {
    const id = await family("Друзья");
    expect((await database().query<{ budget: string }>(
      "SELECT monthly_model_budget_usd::text AS budget FROM families WHERE id = $1", [id])).rows[0]!.budget).toBe("5.00");
    await spend(id, 4.99);
    // Last month's spend and an unpriced call do not count against this month.
    await spend(id, 50, new Date("2026-09-30T23:59:00Z"));
    await spend(id, null);
    expect(await familyBudgetRepository.budgetGate({ familyId: id, now: NOW })).toBe("within");
    await spend(id, 0.01);
    expect(await familyBudgetRepository.budgetGate({ familyId: id, now: NOW })).toBe("notify");
    expect(await familyBudgetRepository.budgetGate({ familyId: id, now: NOW })).toBe("silent");
    expect(await familyBudgetRepository.budgetGate({ familyId: id, now: new Date("2026-11-01T00:00:01Z") })).toBe("within");
  });

  it("bills a recorded call to its own family only, and lists the month in the digest", async () => {
    const a = await family("Альфа", 1);
    const b = await family("Бета", 1);
    // deepseek-v4-flash at the October price table: a large call is well over a dollar.
    await modelUsageRepository.record({
      cacheHitTokens: 0, cacheMissTokens: 20_000_000, familyId: a, modelId: "deepseek-v4-flash", outputTokens: 0, webSearchCalls: 0,
    }, NOW);
    expect(await familyBudgetRepository.budgetGate({ familyId: a, now: NOW })).toBe("notify");
    expect(await familyBudgetRepository.budgetGate({ familyId: b, now: NOW })).toBe("within");
    // The digest names families by ordinal and lists only those with a budget and spend.
    const digest = await familyBudgetRepository.monthSpend(NOW);
    expect(digest.map((row) => [row.familyOrdinal, row.budgetUsd])).toEqual([[1, 1]]);
    expect(digest[0]!.spentUsd).toBeGreaterThan(1);
    expect(formatFamilySpend(digest)).toMatch(/^Расход семей с лимитом за месяц: семья 1 — \d+\.\d{2} из 1\.00 \$ \(исчерпан\)\.$/u);
    expect(formatFamilySpend([])).toBeNull();
  });
});
