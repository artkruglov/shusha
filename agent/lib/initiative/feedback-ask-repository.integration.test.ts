/**
 * Данные вопроса «что мешает» на настоящей базе.
 *
 * Проверяется: семья оператора не спрашивается; новичок первой недели, исчерпавший счёт и сам писавший
 * `/feedback` на этой неделе выпадают; заявка на неделю одна, а следующая неделя открывает новую.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createTwoSpaceFixture, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { feedbackAskRepository } from "./feedback-ask-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let operator: TwoSpaceFixture;
let friends: TwoSpaceFixture;
// Суббота 24 октября 2026, 14:00 по Москве; следующая суббота 31 октября.
const NOW = new Date("2026-10-24T11:00:00Z");
const NEXT_WEEK = new Date("2026-10-31T11:00:00Z");

async function privateChat(fixture: TwoSpaceFixture, person: TwoSpaceFixture["owner"]): Promise<void> {
  await database().query(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, owner_user_id, group_id, scope, kind, task_state,
        conversation_key, continuation_token, started_at, last_activity_at)
     VALUES (gen_random_uuid(), 0, $1, $2, NULL, 'personal', 'canonical', NULL, $3, $3, now(), now())`,
    [fixture.familyId, person.userId, `${person.telegramUserId}::`],
  );
}

async function joined(fixture: TwoSpaceFixture, at: string): Promise<void> {
  await database().query("UPDATE family_memberships SET created_at = $2 WHERE family_id = $1", [fixture.familyId, at]);
}

async function askedIds(at = NOW): Promise<string[]> {
  return (await feedbackAskRepository.recipients(at)).map((recipient) => recipient.userId).sort();
}

dbDescribe("feedback ask data", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE feedback_messages, proactive_deliveries, conversation_sessions, application_conversations,
        initiative_messages, user_notification_settings, spaces, telegram_groups, family_memberships, users,
        families CASCADE`,
    );
    operator = await createTwoSpaceFixture("feedback-ask-operator");
    friends = await createTwoSpaceFixture("feedback-ask-friends");
    await database().query("UPDATE families SET created_at = now() - interval '1 year' WHERE id = $1", [operator.familyId]);
    for (const fixture of [operator, friends]) {
      await joined(fixture, "2026-10-01T00:00:00Z");
      await privateChat(fixture, fixture.owner);
      await privateChat(fixture, fixture.spouse);
    }
  });
  afterAll(closeDatabase);

  it("asks the friend family and never the operator's own", async () => {
    expect(await askedIds()).toEqual([friends.owner.userId, friends.spouse.userId].sort());
  });

  it("leaves out a newcomer of the first week and anyone who has written /feedback this week", async () => {
    await database().query("UPDATE family_memberships SET created_at = '2026-10-20T00:00:00Z' WHERE user_id = $1",
      [friends.spouse.userId]);
    // Отправитель `/feedback` хранится числовым id Telegram, как в настоящем апдейте.
    await database().query("UPDATE users SET telegram_user_id = '700001' WHERE id = $1", [friends.owner.userId]);
    await database().query("UPDATE application_conversations SET telegram_chat_id = '700001' WHERE owner_user_id = $1 AND scope = 'personal'",
      [friends.owner.userId]);
    expect(await askedIds()).toContain(friends.owner.userId);
    await database().query("INSERT INTO feedback_messages(family_id, telegram_user_id, text, created_at) VALUES ($1, '700001', 'мешает', $2)",
      [friends.familyId, "2026-10-22T10:00:00Z"]);
    expect(await askedIds()).toEqual([]);
  });

  it("claims one question a week and stops after the fourth", async () => {
    const recipient = (await feedbackAskRepository.recipients(NOW)).find((one) => one.userId === friends.owner.userId)!;
    expect(recipient.asked).toBe(0);
    await expect(feedbackAskRepository.claim(recipient, "2026-10-24", NOW)).resolves.toMatch(/^[0-9a-f-]{36}$/u);
    await expect(feedbackAskRepository.claim(recipient, "2026-10-24", NOW)).resolves.toBeNull();
    await expect(feedbackAskRepository.claim(recipient, "2026-10-31", NEXT_WEEK)).resolves.not.toBeNull();

    for (const day of ["2026-11-07", "2026-11-14"]) {
      await feedbackAskRepository.claim(recipient, day, new Date(`${day}T11:00:00Z`));
    }
    expect(await askedIds(new Date("2026-11-21T11:00:00Z"))).toEqual([friends.spouse.userId]);
  });
});
