/**
 * «Напомнить и мне» on the real schema (migrations 174 and the reminder tables).
 *
 * Constructs covered:
 * - Two family members pressing one offer get two personal reminders, each their own, at the
 *   offer's time; a second press by the same person does not duplicate theirs.
 * - A member without a timezone gets no reminder and a request to set it.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { reminderRepository } from "../reminders/reminder-repository.js";
import { guestChatRepository } from "./guest-chat-repository.js";
import { createGuestOfferReminder } from "./guest-reminder-callback.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

async function family() {
  const created = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Гости') RETURNING id");
  const familyId = created.rows[0]!.id;
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('9101', 'Артём'), ('9202', 'Максим') RETURNING id, telegram_user_id`,
  );
  const artem = users.rows.find((row) => row.telegram_user_id === "9101")!.id;
  const maxim = users.rows.find((row) => row.telegram_user_id === "9202")!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')",
    [familyId, artem, maxim],
  );
  return {
    artem: { familyId, role: "owner" as const, userId: artem },
    maxim: { familyId, role: "member" as const, userId: maxim },
  };
}

function privateAuth(identity: { familyId: string; role: "member" | "owner"; userId: string }, telegramUserId: string) {
  return {
    familyId: identity.familyId,
    forumTopicId: null,
    groupId: null,
    groupType: null,
    messageThreadId: null,
    role: identity.role,
    telegramChatId: telegramUserId,
    telegramChatType: "private" as const,
    userId: identity.userId,
  };
}

(enabled ? describe : describe.skip)("guest reminder offer", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE telegram_guest_chats, reminders, user_notification_settings, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => {
    await closeDatabase();
  });

  it("gives every pressing member their own reminder once", async () => {
    const people = await family();
    for (const [identity, telegramUserId] of [[people.artem, "9101"], [people.maxim, "9202"]] as const) {
      await reminderRepository.configureNotifications(privateAuth(identity, telegramUserId), {
        quietEnd: null, quietStart: null, timezone: "Europe/Moscow",
      });
    }
    await guestChatRepository.summon("p:501:9202");
    const runAt = new Date(Date.now() + 3 * 86_400_000);
    const { offerId } = await guestChatRepository.apply({
      actions: [{ content: "Встреча физтехов", runAt, type: "reminder" }],
      authorTelegramUserId: "9101",
      shown: [],
      chatKey: "p:501:9202",
    });
    const offer = (await guestChatRepository.findOffer(offerId!))!;

    await expect(createGuestOfferReminder({ identity: people.artem, offer, telegramUserId: "9101" }))
      .resolves.toMatch(/^\d{4}-\d{2}-\d{2} в \d{2}:\d{2}$/u);
    await createGuestOfferReminder({ identity: people.maxim, offer, telegramUserId: "9202" });
    await createGuestOfferReminder({ identity: people.maxim, offer, telegramUserId: "9202" });

    const rows = await database().query<{
      content: string; due_at: Date; owner_user_id: string; scope: string; telegram_chat_id: string;
    }>("SELECT owner_user_id, scope, content, due_at, telegram_chat_id FROM reminders");
    // Each reminder goes to its owner's own private chat, never to the guest chat.
    expect(rows.rows.map((row) => [row.owner_user_id, row.scope, row.content, row.due_at.toISOString(), row.telegram_chat_id])
      .sort()).toEqual([
      [people.artem.userId, "personal", "Встреча физтехов", runAt.toISOString(), "9101"],
      [people.maxim.userId, "personal", "Встреча физтехов", runAt.toISOString(), "9202"],
    ].sort());
  });

  it("asks a member without a timezone to set it first", async () => {
    const people = await family();
    await guestChatRepository.summon("p:501:9202");
    const { offerId } = await guestChatRepository.apply({
      actions: [{ content: "Падл", runAt: new Date(Date.now() + 86_400_000), type: "reminder" }],
      authorTelegramUserId: "9101",
      shown: [],
      chatKey: "p:501:9202",
    });
    const offer = (await guestChatRepository.findOffer(offerId!))!;

    await expect(createGuestOfferReminder({ identity: people.maxim, offer, telegramUserId: "9202" })).resolves.toBeNull();
    expect((await database().query("SELECT 1 FROM reminders")).rowCount).toBe(0);
  });
});
