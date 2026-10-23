/**
 * Две разные семьи: проактивные подборки (коуч, партнёрские уведомления, разбор дел группы,
 * журнал доставок, счётчики инициативы) берут данные только своей семьи.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { proactiveDeliveryRepository } from "../proactive-deliveries/proactive-delivery-repository.js";
import { createTwoFamilies, TWO_FAMILIES_TRUNCATE, type TwoFamilies } from "../two-families-fixture.js";
import { coachRepository } from "./coach-repository.js";
import { groupOverviewRepository } from "./group-overview-repository.js";
import { initiativeRepository } from "./initiative-repository.js";
import { partnerAlertRepository } from "./partner-alert-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let f: TwoFamilies;
const NOW = new Date();

type Fixture = TwoFamilies["a"];

async function privateChat(fixture: Fixture, person: Fixture["owner"]): Promise<void> {
  await database().query(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, owner_user_id, group_id, scope, kind, task_state,
        conversation_key, continuation_token, started_at, last_activity_at)
     VALUES (gen_random_uuid(), 0, $1, $2, NULL, 'personal', 'canonical', NULL, $3, $3, now(), now())`,
    [fixture.familyId, person.userId, `${person.telegramUserId}::`],
  );
}

async function proposeTask(fixture: Fixture, title: string): Promise<void> {
  await database().query(
    `INSERT INTO shared_tasks(family_id, scope, creator_telegram_id, assignee_telegram_id, title, status, kind)
     VALUES ($1, 'family', $2, $3, $4, 'proposed', 'task')`,
    [fixture.familyId, fixture.owner.telegramUserId, fixture.spouse.telegramUserId, title],
  );
}

async function groupMessage(fixture: Fixture): Promise<void> {
  const conversation = (await database().query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id = $1", [fixture.groupId])).rows[0]!.id;
  await database().query(
    `INSERT INTO telegram_group_messages
       (group_id, conversation_id, telegram_message_id, sequence_id, actor_kind, actor_id, telegram_user_id,
        sender_display_name, sender_is_bot, message_kind, content_text, sent_at, telegram_chat_id)
     VALUES ($1, $2, 1, 1, 'user', $3, $4, 'Человек', false, 'text', 'привет', now(), $5)`,
    [fixture.groupId, conversation, `telegram:${fixture.owner.telegramUserId}`, fixture.owner.telegramUserId,
      fixture.telegramChatId],
  );
}

dbDescribe("two families: initiative and proactive data", () => {
  beforeEach(async () => {
    await database().query(TWO_FAMILIES_TRUNCATE);
    await database().query("TRUNCATE partner_alert_claims, group_overview_claims, telegram_group_messages CASCADE");
    f = await createTwoFamilies();
  });
  afterAll(closeDatabase);

  it("shows a partner alert only to the addressed person of the same family", async () => {
    await privateChat(f.a, f.a.spouse);
    await privateChat(f.b, f.b.spouse);
    await proposeTask(f.a, "Дело только для семьи A");
    const recipients = await partnerAlertRepository.recipients(NOW);
    const spouseA = recipients.find((person) => person.userId === f.a.spouse.userId)!;
    const spouseB = recipients.find((person) => person.userId === f.b.spouse.userId)!;
    expect(spouseA.familyId).toBe(f.a.familyId);
    expect(spouseB.familyId).toBe(f.b.familyId);
    expect((await partnerAlertRepository.pending(spouseA, NOW)).items.map((item) => item.title))
      .toEqual(["Дело только для семьи A"]);
    await expect(partnerAlertRepository.pending(spouseB, NOW)).resolves.toEqual({ items: [], pending: 0 });
    // Подделка: семья B, но Telegram-идентификатор адресата из семьи A. Дело семьи A не показывается.
    await expect(partnerAlertRepository.pending(
      { ...spouseB, telegramUserId: f.a.spouse.telegramUserId }, NOW)).resolves.toEqual({ items: [], pending: 0 });
  });

  it("keeps coach recipients, daily claims and initiative counters per family", async () => {
    await privateChat(f.a, f.a.owner);
    await privateChat(f.b, f.b.owner);
    for (const fixture of [f.a, f.b]) {
      await database().query(
        "INSERT INTO user_notification_settings(user_id, timezone, coach_enabled) VALUES ($1, 'UTC', true)",
        [fixture.owner.userId]);
    }
    const recipients = await coachRepository.recipients(NOW);
    const ownerA = recipients.find((person) => person.userId === f.a.owner.userId)!;
    const ownerB = recipients.find((person) => person.userId === f.b.owner.userId)!;
    expect([ownerA.familyId, ownerB.familyId]).toEqual([f.a.familyId, f.b.familyId]);
    const touch = { reason: "invite" as const, subject: null, text: "…" };
    expect(await coachRepository.claim(ownerA, "2030-01-01", touch, NOW)).not.toBeNull();
    // Заявка семьи A не занимает сутки семьи B.
    expect(await coachRepository.claim(ownerB, "2030-01-01", touch, NOW)).not.toBeNull();
    expect((await initiativeRepository.read(f.a.owner.userId, NOW))!.state.sentToday).toBeGreaterThanOrEqual(0);

    await initiativeRepository.record({ familyId: f.a.familyId, kind: "suggestion", now: NOW, userId: f.a.owner.userId });
    const countB = (await database().query(
      "SELECT count(*)::int AS n FROM initiative_messages WHERE family_id = $1", [f.b.familyId])).rows[0].n;
    await initiativeRepository.markAnswered(f.a.owner.userId, new Date(NOW.getTime() + 1000));
    const unansweredB = await database().query(
      "SELECT count(*)::int AS n FROM initiative_messages WHERE family_id = $1 AND answered_at IS NOT NULL", [f.b.familyId]);
    expect(countB).toBe(1);
    expect(unansweredB.rows[0].n).toBe(0);
  });

  it("builds the group overview and its switch from the group's own family only", async () => {
    await groupMessage(f.a);
    await groupMessage(f.b);
    for (const [fixture, title] of [[f.a, "Общее дело A"], [f.b, "Общее дело B"]] as const) {
      await database().query(
        `INSERT INTO shared_tasks(family_id, scope, creator_telegram_id, title, status, kind)
         VALUES ($1, 'family', $2, $3, 'open', 'task')`,
        [fixture.familyId, fixture.owner.telegramUserId, title]);
    }
    const groups = await groupOverviewRepository.groups(NOW);
    const groupA = groups.find((group) => group.familyId === f.a.familyId)!;
    const groupB = groups.find((group) => group.familyId === f.b.familyId)!;
    expect(groupA.groupId).toBe(f.a.groupId);
    expect((await groupOverviewRepository.tasks(groupA)).map((task) => task.title)).toEqual(["Общее дело A"]);
    expect((await groupOverviewRepository.tasks(groupB)).map((task) => task.title)).toEqual(["Общее дело B"]);

    expect(await groupOverviewRepository.claim(groupA, "2030-01-01")).not.toBeNull();
    expect(await groupOverviewRepository.claim(groupA, "2030-01-01")).toBeNull();
    expect(await groupOverviewRepository.claim(groupB, "2030-01-01")).not.toBeNull();

    expect(await groupOverviewRepository.setEnabled(f.a.familyId, false)).toBe(1);
    const enabledRows = await database().query<{ family_id: string; daily_overview_enabled: boolean }>(
      "SELECT family_id, daily_overview_enabled FROM telegram_groups WHERE type = 'family_private'");
    expect(enabledRows.rows.find((row) => row.family_id === f.b.familyId)!.daily_overview_enabled).toBe(true);
    expect(enabledRows.rows.find((row) => row.family_id === f.a.familyId)!.daily_overview_enabled).toBe(false);
  });

  it("does not return family A's proactive deliveries to family B, even with A's group id", async () => {
    const delivery = (fixture: Fixture, scope: "family" | "personal") => ({
      content: `Секретная доставка семьи A (${scope})`,
      deliveredAt: new Date("2030-01-01T06:01:00.000Z"),
      familyId: fixture.familyId,
      groupId: scope === "family" ? fixture.groupId : null,
      messageThreadId: null,
      ownerUserId: scope === "personal" ? fixture.owner.userId : null,
      scheduledFor: new Date("2030-01-01T06:00:00.000Z"),
      scope,
      sourceId: scope === "family" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002",
      sourceKind: "agent_schedule" as const,
      telegramChatId: scope === "family" ? fixture.telegramChatId : fixture.owner.telegramUserId,
      telegramMessageId: scope === "family" ? "11" : "12",
      title: "Доставка",
    });
    await proactiveDeliveryRepository.record(delivery(f.a, "family"));
    await proactiveDeliveryRepository.record(delivery(f.a, "personal"));
    const query = (auth: ReturnType<typeof delivery>) => proactiveDeliveryRepository.list({
      ...auth, deliveredAfter: null, deliveredBefore: null, limit: 10, query: null, sourceKind: null,
    });
    await expect(query(delivery(f.a, "family"))).resolves.toMatchObject({ items: [expect.anything()] });
    for (const scope of ["family", "personal"] as const) {
      // Реквизиты семьи B, но группа, владелец и чат взяты у семьи A.
      const forged = { ...delivery(f.a, scope), familyId: f.b.familyId };
      expect((await query(forged)).items).toEqual([]);
      const honest = delivery(f.b, scope);
      expect((await query(honest)).items).toEqual([]);
    }
  });
});
