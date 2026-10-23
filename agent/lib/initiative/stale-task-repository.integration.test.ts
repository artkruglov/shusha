/**
 * Сообщение о давнем деле на настоящей базе (миграции 190–192).
 *
 * Проверяется: кандидат — просроченное принятое дело, показанное три утра на своей версии; не
 * кандидат после «Оставить», после правки и после сообщения о той же версии; одно сообщение в сутки.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createTwoSpaceFixture, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { overviewRestRepository } from "./overview-rest-repository.js";
import { staleTaskRepository, type StaleTaskRecipient } from "./stale-task-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

const NOW = new Date("2026-10-21T09:00:00Z");
let fixture: TwoSpaceFixture;
let recipient: StaleTaskRecipient;

async function task(title: string, dueOn: string | null): Promise<{ id: string; version: number }> {
  return (await database().query<{ id: string; version: number }>(
    `INSERT INTO shared_tasks (family_id, scope, kind, title, status, creator_telegram_id, assignee_telegram_id, due_on, updated_at)
     VALUES ($1, 'personal', 'task', $2, 'accepted', $3, $3, $4::date, '2026-09-15T10:00:00Z') RETURNING id, version`,
    [fixture.familyId, title, fixture.owner.telegramUserId, dueOn])).rows[0]!;
}

async function shownThrice(row: { id: string; version: number }): Promise<void> {
  for (const day of ["2026-10-18", "2026-10-19", "2026-10-20"]) {
    await overviewRestRepository.recordShows({ familyId: fixture.familyId, shownOn: day, tasks: [row], userId: fixture.owner.userId });
  }
}

dbDescribe("stale task repository", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE stale_task_claims, task_overview_shows, task_overview_rests, initiative_messages, shared_tasks, spaces,
        telegram_groups, family_memberships, users, families CASCADE`,
    );
    fixture = await createTwoSpaceFixture("stale-task");
    recipient = {
      familyId: fixture.familyId, telegramUserId: fixture.owner.telegramUserId, userId: fixture.owner.userId,
      settings: { dailyLimit: 3, enabled: true, quietEnd: null, quietStart: null, timezone: "Europe/Moscow" },
      state: { sentToday: 0, unanswered: 0 },
    } as unknown as StaleTaskRecipient;
  });
  afterAll(closeDatabase);

  it("finds an overdue task shown three mornings unchanged, says since when, and only that one", async () => {
    const stuck = await task("Договориться о встрече", "2026-09-15");
    await shownThrice(stuck);
    const fresh = await task("Сдать ключи", "2026-10-19");
    await overviewRestRepository.recordShows({ familyId: fixture.familyId, shownOn: "2026-10-20", tasks: [fresh], userId: fixture.owner.userId });
    const notDue = await task("Без срока", null);
    await shownThrice(notDue);
    // Повторяющееся дело это серия: «Снять» отменило бы её всю, поэтому сообщения о нём нет.
    const series = await task("Полить цветы", "2026-09-10");
    await database().query("UPDATE shared_tasks SET recurrence_unit='daily', recurrence_interval=1, recurrence_anchor_on=due_on WHERE id=$1", [series.id]);
    await shownThrice(series);

    expect(await staleTaskRepository.candidate(recipient, NOW)).toEqual({
      id: stuck.id, since: "2026-09-15", title: "Договориться о встрече", version: stuck.version,
    });
  });

  it("leaves out a task the person kept, a changed task, and a task already written about at this version", async () => {
    const kept = await task("Оставленное", "2026-09-15");
    await shownThrice(kept);
    await overviewRestRepository.rest({ familyId: fixture.familyId, taskId: kept.id, taskVersion: kept.version, userId: fixture.owner.userId });
    expect(await staleTaskRepository.candidate(recipient, NOW)).toBeNull();

    const stuck = await task("Договориться о встрече", "2026-09-15");
    await shownThrice(stuck);
    await database().query("UPDATE shared_tasks SET version = version + 1 WHERE id = $1", [stuck.id]);
    expect(await staleTaskRepository.candidate(recipient, NOW)).toBeNull();

    const other = await task("Позвонить мастеру", "2026-09-20");
    await shownThrice(other);
    const found = (await staleTaskRepository.candidate(recipient, NOW))!;
    expect(await staleTaskRepository.claim(recipient, "2026-10-21", found, NOW)).not.toBeNull();
    expect(await staleTaskRepository.candidate(recipient, NOW)).toBeNull();
  });

  it("claims one message per person and day", async () => {
    const first = await task("Первое", "2026-09-15");
    const second = await task("Второе", "2026-09-16");
    const as = (row: { id: string; version: number }) => ({ ...row, since: "2026-09-15", title: "x" });

    expect(await staleTaskRepository.claim(recipient, "2026-10-21", as(first), NOW)).not.toBeNull();
    expect(await staleTaskRepository.claim(recipient, "2026-10-21", as(second), NOW)).toBeNull();
    expect(await staleTaskRepository.claim(recipient, "2026-10-22", as(second), NOW)).not.toBeNull();
  });
});
