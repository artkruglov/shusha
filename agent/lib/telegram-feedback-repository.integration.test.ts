/**
 * `/feedback` rows on the real schema (migration 182).
 *
 * Constructs covered:
 * - A row names the family by its creation ordinal; the operator is the owner of the earliest family.
 * - The sixth text of a day is refused, and the limit is per person.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { FEEDBACK_DAILY_LIMIT, feedbackRepository } from "./telegram-feedback-command.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

const NOW = new Date("2026-10-18T12:00:00Z");

(enabled ? describe : describe.skip)("feedback repository", () => {
  let second: string;

  beforeEach(async () => {
    await database().query("TRUNCATE families, users CASCADE");
    const families = await database().query<{ id: string }>(
      "INSERT INTO families(name, created_at) VALUES('Оператор', now() - interval '1 day'), ('Друзья', now()) RETURNING id");
    const people = await database().query<{ id: string }>(
      "INSERT INTO users(telegram_user_id, display_name) VALUES('800001','Оператор'),('800002','Друг') RETURNING id");
    await database().query("INSERT INTO family_memberships(family_id, user_id, role) VALUES($1,$2,'owner'),($3,$4,'owner')",
      [families.rows[0]!.id, people.rows[0]!.id, families.rows[1]!.id, people.rows[1]!.id]);
    second = families.rows[1]!.id;
  });
  afterAll(closeDatabase);

  it("numbers the family, finds the operator and stops at the daily limit", async () => {
    expect(await feedbackRepository.operatorChatId()).toBe("800001");
    const first = await feedbackRepository.record({ familyId: second, now: NOW, telegramUserId: "800002", text: "Мешает" });
    expect(first).toMatchObject({ familyOrdinal: 2 });
    for (let index = 1; index < FEEDBACK_DAILY_LIMIT; index += 1) {
      expect(await feedbackRepository.record({ familyId: second, now: NOW, telegramUserId: "800002", text: `ещё ${index}` })).not.toBeNull();
    }
    expect(await feedbackRepository.record({ familyId: second, now: NOW, telegramUserId: "800002", text: "лишнее" })).toBeNull();
    // Another person of the same family has their own limit; a day later the first one may write again.
    expect(await feedbackRepository.record({ familyId: second, now: NOW, telegramUserId: "800003", text: "Я" })).not.toBeNull();
    expect(await feedbackRepository.record({
      familyId: second, now: new Date("2026-10-19T12:00:01Z"), telegramUserId: "800002", text: "Завтра",
    })).not.toBeNull();
    await feedbackRepository.markDelivered(first!.id, NOW);
    const row = await database().query<{ delivered: boolean }>(
      "SELECT delivered_at IS NOT NULL AS delivered FROM feedback_messages WHERE id = $1", [first!.id]);
    expect(row.rows[0]!.delivered).toBe(true);
  });
});
