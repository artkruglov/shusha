/**
 * Данные разбора семейных дел: группа выбирается по активности и выключателю, дела только общие,
 * заявка на сутки одна.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import {
  createThreadRepositoryFixture,
  type ThreadRepositoryFixture,
} from "../memory-thread-repository.integration-fixtures.js";
import { recordGroupOverviewDelivery } from "./group-overview-delivery.js";
import { createGroupOverviewDispatcher } from "./group-overview-dispatch.js";
import { groupOverviewRepository } from "./group-overview-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

let fixture: ThreadRepositoryFixture;

// Свободное дело это `open` без исполнителя, принятое обязано иметь исполнителя: так требует схема.
async function insertTask(scope: "family" | "personal", title: string, status = "open", assignee: string | null = null) {
  await database().query(
    `INSERT INTO shared_tasks(family_id, scope, creator_telegram_id, assignee_telegram_id, title, status, kind)
     VALUES ($1, $2, 'thread-owner', $3, $4, $5, 'task')`,
    [fixture.familyId, scope, assignee, title, status],
  );
}

describeWithDatabase("group overview data", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE proactive_deliveries, group_overview_claims, shared_tasks, memory_items_all, telegram_group_messages, telegram_groups,
         user_notification_settings, family_memberships, users, families CASCADE`,
    );
    fixture = await createThreadRepositoryFixture();
  });
  afterAll(async () => { await closeDatabase(); });

  it("picks a family group where somebody wrote lately, in the owner's timezone", async () => {
    await database().query(
      "INSERT INTO user_notification_settings(user_id, timezone) VALUES ($1, 'Europe/Moscow')", [fixture.userId],
    );

    const groups = await groupOverviewRepository.groups(new Date());

    expect(groups).toEqual([expect.objectContaining({
      familyId: fixture.familyId, firstEver: true, groupId: fixture.groupId, timezone: "Europe/Moscow",
    })]);
  });

  it("skips a quiet group and a group whose overview was switched off", async () => {
    // Через две недели после последнего сообщения группа считается мёртвой.
    expect(await groupOverviewRepository.groups(new Date(Date.now() + 14 * 86_400_000))).toEqual([]);

    expect(await groupOverviewRepository.setEnabled(fixture.familyId, false)).toBe(1);
    expect(await groupOverviewRepository.groups(new Date())).toEqual([]);
    expect(await groupOverviewRepository.setEnabled(fixture.familyId, true)).toBe(1);
    expect(await groupOverviewRepository.groups(new Date())).toHaveLength(1);
  });

  it("reads only the shared tasks of the family and names the assignee", async () => {
    await database().query(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('julia-tg', 'Юля')",
    );
    await insertTask("family", "Купить хлеб");
    await insertTask("family", "Записаться к врачу", "accepted", "julia-tg");
    await insertTask("personal", "Личное, не для группы", "accepted", "thread-owner");
    await insertTask("family", "Уже сделано", "completed", "thread-owner");

    const [group] = await groupOverviewRepository.groups(new Date());
    const tasks = await groupOverviewRepository.tasks(group!);

    expect(tasks.map((task) => task.title).sort()).toEqual(["Записаться к врачу", "Купить хлеб"]);
    expect(tasks.find((task) => task.title === "Записаться к врачу")?.assigneeName).toBe("Юля");
  });

  it("gives one claim per group and day", async () => {
    const [group] = await groupOverviewRepository.groups(new Date());

    expect(await groupOverviewRepository.claim(group!, "2026-09-29")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await groupOverviewRepository.claim(group!, "2026-09-29")).toBeNull();
    expect(await groupOverviewRepository.claim(group!, "2026-09-30")).not.toBeNull();
    expect((await groupOverviewRepository.groups(new Date()))[0]?.firstEver).toBe(false);
  });
  it("posts a real overview end to end and journals it under the group", async () => {
    // Часовой пояс подбирается так, чтобы у семьи прямо сейчас было утро после девяти.
    const now = new Date();
    const zone = ["UTC", "Asia/Tokyo", "America/New_York", "Pacific/Kiritimati"].find((candidate) =>
      Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: candidate }).format(now)) % 24 >= 9)!;
    await database().query(
      "INSERT INTO user_notification_settings(user_id, timezone) VALUES ($1, $2)", [fixture.userId, zone],
    );
    await insertTask("family", "Купить хлеб");
    const sent: { chatId: string; text: string }[] = [];
    const dispatch = createGroupOverviewDispatcher({
      claim: (group, localDate) => groupOverviewRepository.claim(group, localDate),
      groups: () => groupOverviewRepository.groups(now),
      overview: async (group, at) => ({ now: at, tasks: await groupOverviewRepository.tasks(group), timezone: group.timezone }),
      record: recordGroupOverviewDelivery,
      send: async (input) => { sent.push(input); return "4242"; },
    });

    await expect(dispatch(now)).resolves.toBe(1);
    // Второй тик того же утра ничего не отправляет: заявка на сутки уже занята.
    await expect(dispatch(now)).resolves.toBe(0);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Купить хлеб");
    const journal = await database().query<{ scope: string; group_id: string | null; owner_user_id: string | null; source_kind: string }>(
      "SELECT scope, group_id, owner_user_id, source_kind FROM proactive_deliveries WHERE telegram_message_id = 4242",
    );
    expect(journal.rows).toEqual([{ group_id: fixture.groupId, owner_user_id: null, scope: "family", source_kind: "group_overview" }]);
  });
});
