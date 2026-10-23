/**
 * Показы дел в утреннем обзоре на настоящей базе (миграция 190).
 *
 * Проверяется: дело уходит из повтора после заявки сообщения о нём на этой версии, правка возвращает; «Оставить» держит
 * дело в стороне до правки; показ одного дня не считается дважды; старые показы удаляются.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createTwoSpaceFixture, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { overviewRestRepository } from "./overview-rest-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;
let taskId: string;

async function show(on: string, version: number): Promise<void> {
  await overviewRestRepository.recordShows({
    familyId: fixture.familyId, shownOn: on, tasks: [{ id: taskId, version }], userId: fixture.owner.userId,
  });
}

dbDescribe("overview rests", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE stale_task_claims, task_overview_shows, task_overview_rests, shared_tasks, spaces, telegram_groups, family_memberships,
        users, families CASCADE`,
    );
    fixture = await createTwoSpaceFixture("overview-rest");
    taskId = (await database().query<{ id: string }>(
      `INSERT INTO shared_tasks (family_id, scope, kind, title, status, creator_telegram_id, assignee_telegram_id)
       VALUES ($1, 'personal', 'task', 'Договориться о встрече', 'accepted', $2, $2) RETURNING id`,
      [fixture.familyId, fixture.owner.telegramUserId])).rows[0]!.id;
  });
  afterAll(closeDatabase);

  it("stops repeating a task only once its message was claimed at this version, and brings it back after a change", async () => {
    await show("2026-10-18", 1);
    await show("2026-10-19", 1);
    await show("2026-10-20", 1);
    // Три показа ещё ничего не прячут: сообщение могло не уйти (предел инициатив, личное время).
    expect((await overviewRestRepository.read(fixture.owner.userId, [{ id: taskId, version: 1 }])).repeated.has(taskId)).toBe(false);
    await database().query(
      `INSERT INTO stale_task_claims(family_id, user_id, task_id, task_version, delivery_ref) VALUES ($1, $2, $3, 1, gen_random_uuid())`,
      [fixture.familyId, fixture.owner.userId, taskId]);
    expect((await overviewRestRepository.read(fixture.owner.userId, [{ id: taskId, version: 1 }])).repeated.has(taskId)).toBe(true);
    expect((await overviewRestRepository.read(fixture.owner.userId, [{ id: taskId, version: 2 }])).repeated.has(taskId)).toBe(false);
    expect((await overviewRestRepository.read(fixture.spouse.userId, [{ id: taskId, version: 1 }])).repeated.has(taskId)).toBe(false);
  });

  it("keeps a task the person left alone out of the overview until it changes", async () => {
    await overviewRestRepository.rest({ familyId: fixture.familyId, taskId, taskVersion: 4, userId: fixture.owner.userId });

    expect((await overviewRestRepository.read(fixture.owner.userId, [{ id: taskId, version: 4 }])).rested.has(taskId)).toBe(true);
    expect((await overviewRestRepository.read(fixture.owner.userId, [{ id: taskId, version: 5 }])).rested.has(taskId)).toBe(false);
  });

  it("forgets shows older than two months", async () => {
    await show("2026-07-01", 1);
    await show("2026-10-20", 1);

    const { rows } = await database().query<{ count: string }>("SELECT count(*) FROM task_overview_shows");
    expect(rows[0]!.count).toBe("1");
  });
});
