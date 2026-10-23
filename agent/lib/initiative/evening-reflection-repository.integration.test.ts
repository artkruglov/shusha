/**
 * Данные итога дня на настоящей базе (миграции 195–196).
 *
 * Проверяется: итог получают все, кроме нажавших «Не писать вечером»; закрытое сегодня — только самим человеком, в
 * его местные сутки, не повтор и не дело, которое снова открыто, и не чужое личное; открытое на сегодня берётся из
 * его обзора; первый итог объясняет себя; заявка одна на сутки.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createTwoSpaceFixture, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { eveningReflectionRepository } from "./evening-reflection-repository.js";
import { featureTipRepository } from "./feature-tip-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;
// Среда 21 октября 2026, 20:30 по Москве.
const NOW = new Date("2026-10-21T17:30:00Z");

async function privateChat(person: TwoSpaceFixture["owner"]): Promise<void> {
  await database().query(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, owner_user_id, group_id, scope, kind, task_state,
        conversation_key, continuation_token, started_at, last_activity_at)
     VALUES (gen_random_uuid(), 0, $1, $2, NULL, 'personal', 'canonical', NULL, $3, $3, now(), now())`,
    [fixture.familyId, person.userId, `${person.telegramUserId}::`],
  );
}

async function task(input: {
  actor?: string; closedAt?: string; dueOn?: string | null; owner: TwoSpaceFixture["owner"]; scope?: "family" | "personal";
  status: string; title: string;
}): Promise<void> {
  const id = (await database().query<{ id: string }>(
    `INSERT INTO shared_tasks(family_id, scope, creator_telegram_id, assignee_telegram_id, title, status, kind, due_on)
     VALUES ($1, $2::memory_scope, $3, $3, $4, $5, 'task', $6::date) RETURNING id`,
    [fixture.familyId, input.scope ?? "personal", input.owner.telegramUserId, input.title, input.status, input.dueOn ?? null],
  )).rows[0]!.id;
  if (input.closedAt) {
    await database().query(
      `INSERT INTO shared_task_versions(task_id, version, actor_telegram_id, action, previous_record, created_at)
       VALUES ($1, 1, $2, 'complete', '{}'::jsonb, $3)`,
      [id, input.actor ?? input.owner.telegramUserId, input.closedAt]);
  }
}

async function owner() {
  return (await eveningReflectionRepository.recipients(NOW)).find((one) => one.userId === fixture.owner.userId)!;
}

dbDescribe("evening reflection data", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE audit_events, proactive_deliveries, conversation_sessions, application_conversations, shared_tasks,
        initiative_messages, user_notification_settings, spaces, telegram_groups, family_memberships, users, families CASCADE`,
    );
    fixture = await createTwoSpaceFixture("evening");
    await privateChat(fixture.owner);
    await privateChat(fixture.spouse);
    await database().query("INSERT INTO user_notification_settings(user_id, timezone) VALUES ($1, 'Europe/Moscow')", [fixture.owner.userId]);
  });
  afterAll(closeDatabase);

  it("writes to everyone who has not pressed «Не писать вечером»", async () => {
    const ids = async () => (await eveningReflectionRepository.recipients(NOW)).map((one) => one.userId).sort();
    expect(await ids()).toEqual([fixture.owner.userId, fixture.spouse.userId].sort());
    await featureTipRepository.switchOff({ familyId: fixture.familyId, setting: "evening_reflection", userId: fixture.spouse.userId });
    expect(await ids()).toEqual([fixture.owner.userId]);
  });

  it("reads the person's own day and claims once a day", async () => {
    await task({ closedAt: "2026-10-21T07:00:00Z", owner: fixture.owner, status: "completed", title: "Купить хлеб" });
    await task({ closedAt: "2026-10-21T15:00:00Z", owner: fixture.owner, scope: "family", status: "completed", title: "Вынести мусор" });
    // Вчера по Москве (23:30 20 октября), снова открытое и закрытое другим человеком — не сегодняшнее его.
    await task({ closedAt: "2026-10-20T20:30:00Z", owner: fixture.owner, status: "completed", title: "Вчерашнее" });
    await task({ closedAt: "2026-10-21T08:00:00Z", owner: fixture.owner, status: "accepted", title: "Открыто снова" });
    await task({ actor: fixture.spouse.telegramUserId, closedAt: "2026-10-21T08:00:00Z", owner: fixture.spouse, scope: "family",
      status: "completed", title: "Закрыла жена" });
    // Даже если событие записано на него, личное дело жены в его итог не попадает.
    await task({ actor: fixture.owner.telegramUserId, closedAt: "2026-10-21T09:00:00Z", owner: fixture.spouse, status: "completed",
      title: "Личное жены" });
    await task({ dueOn: "2026-10-21", owner: fixture.owner, status: "accepted", title: "Позвонить врачу" });
    await task({ dueOn: "2026-10-21", owner: fixture.spouse, status: "accepted", title: "Дело жены на сегодня" });

    const recipient = await owner();
    const day = await eveningReflectionRepository.content(recipient, "2026-10-21", NOW);
    expect(day.closed).toEqual(["Купить хлеб", "Вынести мусор"]);
    expect(day.openToday).toEqual(["Позвонить врачу"]);
    expect(day.first).toBe(true);

    await expect(eveningReflectionRepository.claim(recipient, "2026-10-21", NOW)).resolves.toMatch(/^[0-9a-f-]{36}$/u);
    await expect(eveningReflectionRepository.claim(recipient, "2026-10-21", NOW)).resolves.toBeNull();
    expect((await eveningReflectionRepository.content(recipient, "2026-10-22", new Date("2026-10-22T17:30:00Z"))).first).toBe(false);
    await expect(eveningReflectionRepository.claim(recipient, "2026-10-22", new Date("2026-10-22T17:30:00Z"))).resolves.not.toBeNull();
  });
});
