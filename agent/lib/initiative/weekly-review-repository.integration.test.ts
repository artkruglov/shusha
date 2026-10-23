/**
 * Данные недельного обзора на настоящей базе.
 *
 * Проверяется: обзор получают только те, кто сам его попросил; заявка на неделю одна, а следующая
 * неделя открывает новую; счётчик закрытого считает выполнения ровно последних семи дней.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createTwoSpaceFixture, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { weeklyReviewRepository } from "./weekly-review-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;
// Воскресенье 27 сентября 2026, 19:00 по Москве; следующее воскресенье 4 октября.
const NOW = new Date("2026-09-27T16:00:00Z");
const NEXT_WEEK = new Date("2026-10-04T16:00:00Z");

/** Человек сам написал боту в личку: у него есть каноническая личная сессия. */
async function privateChat(person: TwoSpaceFixture["owner"]): Promise<void> {
  await database().query(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, owner_user_id, group_id, scope, kind, task_state,
        conversation_key, continuation_token, started_at, last_activity_at)
     VALUES (gen_random_uuid(), 0, $1, $2, NULL, 'personal', 'canonical', NULL, $3, $3, now(), now())`,
    [fixture.familyId, person.userId, `${person.telegramUserId}::`],
  );
}

async function settings(person: TwoSpaceFixture["owner"], review: boolean | null): Promise<void> {
  await database().query(
    "INSERT INTO user_notification_settings(user_id, timezone, weekly_review_enabled) VALUES ($1, 'Europe/Moscow', $2)",
    [person.userId, review],
  );
}

async function ownerRecipient() {
  const recipients = await weeklyReviewRepository.recipients(NOW);
  return recipients.find((recipient) => recipient.userId === fixture.owner.userId);
}

dbDescribe("weekly review data", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE proactive_deliveries, conversation_sessions, application_conversations, joint_decisions,
        personal_time_windows, shared_tasks, initiative_messages, user_notification_settings, spaces,
        telegram_groups, family_memberships, users, families CASCADE`,
    );
    fixture = await createTwoSpaceFixture("weekly-review");
  });
  afterAll(closeDatabase);

  it("writes to everyone who has not said stop, and to nobody who has", async () => {
    await privateChat(fixture.owner);
    await privateChat(fixture.spouse);
    // Включён по умолчанию (30 сентября 2026): молчание значит «можно», «хватит обзоров» это отказ.
    await settings(fixture.owner, null);
    await settings(fixture.spouse, false);
    const recipients = await weeklyReviewRepository.recipients(NOW);
    expect(recipients.map((recipient) => recipient.userId)).toEqual([fixture.owner.userId]);
    expect(recipients[0]).toMatchObject({ enabled: true, settings: { timezone: "Europe/Moscow" } });
  });

  it("claims one review a week and opens the next one seven days later", async () => {
    await privateChat(fixture.owner);
    await settings(fixture.owner, true);
    const recipient = (await ownerRecipient())!;

    const first = await weeklyReviewRepository.claim(recipient, "2026-09-27", NOW);
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    // Следующий десятиминутный тик того же вечера второго обзора не шлёт.
    await expect(weeklyReviewRepository.claim(recipient, "2026-09-27", NOW)).resolves.toBeNull();
    await expect(weeklyReviewRepository.claim(recipient, "2026-10-04", NEXT_WEEK)).resolves.not.toBeNull();
  });

  it("counts completions of the last seven days, each occurrence of a repeat, nothing moved or reopened", async () => {
    await privateChat(fixture.owner);
    await settings(fixture.owner, true);
    const insert = async (title: string, status: string, completedDaysAgo: readonly number[], repeat = false) => {
      const id = (await database().query<{ id: string }>(
        `INSERT INTO shared_tasks(family_id, scope, creator_telegram_id, assignee_telegram_id, title, status, kind,
                                  created_at, updated_at, recurrence_unit, recurrence_interval, recurrence_anchor_on, due_on)
         VALUES ($1, 'personal', $2, $2, $3, $4, 'task', now() - interval '60 days', $5,
                 $6, $7, $8::date, $8::date) RETURNING id`,
        [fixture.familyId, fixture.owner.telegramUserId, title, status, NOW,
          repeat ? "weekly" : null, repeat ? 1 : null, repeat ? "2026-10-01" : null])).rows[0]!.id;
      for (const [index, days] of completedDaysAgo.entries()) {
        await database().query(
          `INSERT INTO shared_task_versions(task_id, version, actor_telegram_id, action, previous_record, created_at)
           VALUES ($1, $2, $3, 'complete', '{}'::jsonb, $4::timestamptz - make_interval(days => $5))`,
          [id, index + 1, fixture.owner.telegramUserId, NOW, days]);
      }
    };
    await insert("Закрыто вчера", "completed", [1]);
    // Слияние проектов только что тронуло строку (updated_at сейчас), а закрыто дело месяц назад.
    await insert("Закрыто месяц назад, перенесено", "completed", [30]);
    await insert("Закрыто и открыто снова", "accepted", [2]);
    await insert("Полить цветы", "accepted", [6, 1], true);
    await insert("Ещё открыто", "accepted", []);

    const review = await weeklyReviewRepository.review((await ownerRecipient())!, NOW);

    expect(review.closedLastWeek).toBe(3);
    expect(review.timezone).toBe("Europe/Moscow");
    expect(review.tasks.map((task) => task.title)).toContain("Ещё открыто");
    expect(review.tasks.map((task) => task.title)).not.toContain("Закрыто вчера");
  });
});
