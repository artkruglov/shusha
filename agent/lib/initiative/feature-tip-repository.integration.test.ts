/**
 * Данные «фишки» и того, что человек попробовал, на настоящей базе (миграции 195–196).
 *
 * Проверяется: советы получают все, кроме сказавших «не присылать советы» и новичков первых двух дней; заявка одна
 * на день и один показ на совет; ответ на совет засчитывается один раз; выключатели пишут только свою строку;
 * хук копит использования; фото, голосовое, разговор, просьба другому и гостевой режим видны из уже лежащих данных.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { featureTipByNumber } from "../coach-touches/feature-tips.js";
import { featureUseRepository } from "../feature-uses/feature-use-repository.js";
import { featureTipKeyboard } from "../task-buttons/coach-touch-keyboard.js";
import { coachTouchPressDependencies, COACH_TOUCH_TEXT, pressCoachTouch } from "../task-buttons/coach-touch-press.js";
import { parseTaskButtonCallbackData } from "../task-buttons/task-button-callback-data.js";
import { taskButtonRepository } from "../task-buttons/task-button-repository.js";
import { createTwoSpaceFixture, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { featureTipRepository } from "./feature-tip-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;
// Вторник 27 октября 2026, 14:00 по Москве.
const NOW = new Date("2026-10-27T11:00:00Z");

async function privateChat(person: TwoSpaceFixture["owner"]): Promise<void> {
  await database().query(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, owner_user_id, group_id, scope, kind, task_state,
        conversation_key, continuation_token, started_at, last_activity_at)
     VALUES (gen_random_uuid(), 0, $1, $2, NULL, 'personal', 'canonical', NULL, $3, $3, now(), now())`,
    [fixture.familyId, person.userId, `${person.telegramUserId}::`],
  );
}

let updateId = 1;
async function message(person: { telegramUserId: string }, body: Record<string, unknown>, voice = false): Promise<void> {
  const key = `${person.telegramUserId}::`;
  const queue = await database().query<{ id: string }>(
    `INSERT INTO telegram_ingress_queues (current_continuation_key) VALUES ($1)
     ON CONFLICT (current_continuation_key) DO UPDATE SET updated_at = now() RETURNING id`, [key]);
  const payload = { message: { chat: { id: Number(person.telegramUserId), type: "private" },
    from: { id: Number(person.telegramUserId) }, ...body } };
  await database().query(
    `INSERT INTO telegram_ingress_updates (update_id, queue_id, ingress_continuation_key, payload, status, completed_at, voice_file_id)
     VALUES ($1, $2, $3, $4::jsonb, 'completed', now(), $5)`,
    [updateId++, queue.rows[0]!.id, key, JSON.stringify(payload), voice ? "voice-file" : null]);
}

async function recipientIds(at = NOW): Promise<string[]> {
  return (await featureTipRepository.recipients(at)).map((recipient) => recipient.userId).sort();
}

dbDescribe("feature tip data", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE feature_uses, feature_tip_shows, telegram_ingress_queues, telegram_guest_usage, audit_events,
        proactive_deliveries, conversation_sessions, application_conversations, shared_tasks, initiative_messages,
        user_notification_settings, spaces, telegram_groups, family_memberships, users, families CASCADE`,
    );
    fixture = await createTwoSpaceFixture("feature-tip");
    await database().query("UPDATE family_memberships SET created_at = '2026-10-01T00:00:00Z' WHERE family_id = $1", [fixture.familyId]);
    await privateChat(fixture.owner);
    await privateChat(fixture.spouse);
  });
  afterAll(closeDatabase);

  it("leaves out whoever said stop and a newcomer still in the first-steps quest", async () => {
    expect(await recipientIds()).toEqual([fixture.owner.userId, fixture.spouse.userId].sort());
    await featureTipRepository.switchOff({ familyId: fixture.familyId, setting: "feature_tips", userId: fixture.spouse.userId });
    expect(await recipientIds()).toEqual([fixture.owner.userId]);
    await database().query("UPDATE family_memberships SET created_at = '2026-10-22T12:00:00Z' WHERE user_id = $1", [fixture.owner.userId]);
    expect(await recipientIds()).toEqual([]);
    // Прошедшему знакомство советы идут сразу, без ожидания его дней.
    await database().query(
      "INSERT INTO onboarding_quest_marks(family_id, user_id, mark) VALUES ($1, $2, 'final')", [fixture.familyId, fixture.owner.userId]);
    expect(await recipientIds()).toEqual([fixture.owner.userId]);
  });

  it("claims one tip a day and shows each tip once", async () => {
    const recipient = (await featureTipRepository.recipients(NOW)).find((one) => one.userId === fixture.owner.userId)!;
    expect(await featureTipRepository.shown(recipient)).toEqual(new Set());
    const ref = await featureTipRepository.claim(recipient, "2026-10-27", "homework", NOW);
    expect(ref).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(featureTipRepository.claim(recipient, "2026-10-27", "voice_tasks", NOW)).resolves.toBeNull();
    // Тот же совет в другой день не приходит, и заявку дня он не тратит.
    await expect(featureTipRepository.claim(recipient, "2026-10-30", "homework", NOW)).resolves.toBeNull();
    await expect(featureTipRepository.claim(recipient, "2026-10-30", "voice_tasks", NOW)).resolves.not.toBeNull();
    expect(await featureTipRepository.shown(recipient)).toEqual(new Set(["homework", "voice_tasks"]));

    await expect(featureTipRepository.answer({ now: NOW, outcome: "tried", tipId: "homework", userId: fixture.owner.userId }))
      .resolves.toBe(ref);
    await expect(featureTipRepository.answer({ now: NOW, outcome: "dismissed", tipId: "homework", userId: fixture.owner.userId }))
      .resolves.toBeNull();
    await expect(featureTipRepository.answer({ now: NOW, outcome: "tried", tipId: "homework", userId: fixture.spouse.userId }))
      .resolves.toBeNull();
    const { rows } = await database().query("SELECT outcome FROM feature_tip_shows WHERE tip_id = 'homework'");
    expect(rows).toEqual([{ outcome: "tried" }]);
  });

  it("keeps the tip in its buttons, and «Попробовать» sends the try text once", async () => {
    const recipient = (await featureTipRepository.recipients(NOW)).find((one) => one.userId === fixture.owner.userId)!;
    const tip = featureTipByNumber(1)!;
    await featureTipRepository.claim(recipient, "2026-10-27", tip.id, NOW);
    const chat = "700001";
    const keyboard = await featureTipKeyboard({ familyId: fixture.familyId, now: NOW, telegramUserId: chat, tip });
    const rows = await Promise.all(keyboard.inline_keyboard.flat().map((button) =>
      taskButtonRepository.find(parseTaskButtonCallbackData((button as { callback_data: string }).callback_data)!, NOW)));
    expect(rows.map((row) => [row!.action, row!.tipNumber, row!.taskId, row!.recipientTelegramId])).toEqual([
      ["tip_try", 1, null, chat],
      ["tip_dismiss", 1, null, chat],
      ["tips_off", null, null, chat],
    ]);

    const sent: string[] = [];
    const recorded: string[] = [];
    const deps = {
      ...coachTouchPressDependencies,
      async record(delivery: { sourceKind: string }) { recorded.push(delivery.sourceKind); },
      async send(input: { text: string }) { sent.push(input.text); return "900"; },
    };
    const auth = { familyId: fixture.familyId, userId: fixture.owner.userId } as never;
    const press = { auth, chatId: chat, now: NOW, row: { ...rows[0]!, action: "tip_try" as const } };
    await expect(pressCoachTouch(deps, press)).resolves.toBe(COACH_TOUCH_TEXT.tried);
    await expect(pressCoachTouch(deps, press)).resolves.toBe(COACH_TOUCH_TEXT.answered);
    expect(sent).toEqual([tip.tryText]);
    expect(recorded).toEqual(["feature_tip"]);
  });

  it("switches off only the presser's own row and audits it", async () => {
    await featureTipRepository.switchOff({ familyId: fixture.familyId, setting: "evening_reflection", userId: fixture.owner.userId });
    const { rows } = await database().query(
      "SELECT user_id, evening_reflection_enabled, feature_tips_enabled FROM user_notification_settings");
    expect(rows).toEqual([{ evening_reflection_enabled: false, feature_tips_enabled: null, user_id: fixture.owner.userId }]);
    const audit = await database().query("SELECT event_type FROM audit_events WHERE actor_user_id = $1", [fixture.owner.userId]);
    expect(audit.rows).toEqual([{ event_type: "notifications.evening_reflection" }]);
  });

  it("counts uses from the hook and reads the rest from data already kept", async () => {
    // Числовые id Telegram, как в настоящих обновлениях и в счётчике гостевого режима.
    const owner = { familyId: fixture.familyId, telegramUserId: "700001", userId: fixture.owner.userId };
    const spouse = { familyId: fixture.familyId, telegramUserId: "700002", userId: fixture.spouse.userId };
    expect(await featureUseRepository.used(owner)).toEqual(new Set());

    await featureUseRepository.record({ familyId: fixture.familyId, features: ["web_search", "image"], now: NOW, userId: fixture.owner.userId });
    await featureUseRepository.record({ familyId: fixture.familyId, features: ["web_search"], now: new Date("2026-10-28T10:00:00Z"),
      userId: fixture.owner.userId });
    const uses = await database().query("SELECT feature, uses, last_used_at FROM feature_uses ORDER BY feature");
    expect(uses.rows).toEqual([
      { feature: "image", last_used_at: NOW, uses: 1 },
      { feature: "web_search", last_used_at: new Date("2026-10-28T10:00:00Z"), uses: 2 },
    ]);

    await message(owner, { photo: [{ file_id: "p" }] });
    await message(owner, { voice: { file_id: "v" } }, true);
    for (let index = 0; index < 8; index += 1) await message(owner, { text: `привет ${index}` });
    // Документ из лички другого человека засчитывается только ему.
    await message(spouse, { document: { file_id: "d" } });
    await database().query(
      `INSERT INTO shared_tasks(family_id, scope, creator_telegram_id, assignee_telegram_id, title, status, kind)
       VALUES ($1, 'family', $2, $3, 'Купить хлеб', 'proposed', 'task')`,
      [fixture.familyId, owner.telegramUserId, spouse.telegramUserId]);
    await database().query("INSERT INTO telegram_guest_usage(usage_day, telegram_user_id, answers) VALUES ('2026-10-20', $1::bigint, 1)",
      [owner.telegramUserId]);

    expect([...await featureUseRepository.used(owner)].sort()).toEqual(
      ["chat", "guest", "image", "photo", "request", "voice", "web_search"]);
    expect([...await featureUseRepository.used(spouse)].sort()).toEqual(["document"]);
  });

  it("does not record a use for someone outside the family", async () => {
    const other = await createTwoSpaceFixture("feature-tip-other");
    await featureUseRepository.record({ familyId: fixture.familyId, features: ["video"], now: NOW, userId: other.owner.userId });
    expect((await database().query("SELECT 1 FROM feature_uses")).rowCount).toBe(0);
  });
});
