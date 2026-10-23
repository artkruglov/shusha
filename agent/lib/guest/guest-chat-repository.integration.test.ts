/**
 * Guest chat notes on the real schema (migration 174).
 *
 * Constructs covered:
 * - A summon creates the chat and returns its notes in creation order.
 * - Actions apply in one transaction; list numbers resolve against the list the prompt showed, and a
 *   number outside it is skipped.
 * - Done notes stay visible for a week; forget-all removes notes and offers of that chat only.
 * - An offer is found until its time; chats not summoned for 90 days are purged with their content.
 * - Past the shown limit the newest notes are listed, still oldest first.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { guestChatRepository } from "./guest-chat-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

const CHAT = "p:101:202";
const OTHER = "c:-1001234";
const later = (days: number) => new Date(Date.now() + days * 86_400_000);

(enabled ? describe : describe.skip)("guest chat repository", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_guest_chats CASCADE");
  });
  afterAll(async () => {
    await closeDatabase();
  });

  it("keeps notes per chat and resolves list numbers against the shown list", async () => {
    expect(await guestChatRepository.summon(CHAT)).toEqual([]);
    await guestChatRepository.apply({
      actions: [
        { content: "Падл с Максимом", dueOn: null, type: "remember" },
        { content: "Физтехи", dueOn: "2026-10-16", type: "remember" },
      ],
      authorTelegramUserId: "101",
      shown: [],
      chatKey: CHAT,
    });
    await guestChatRepository.summon(OTHER);
    await guestChatRepository.apply({
      actions: [{ content: "Чужое", dueOn: null, type: "remember" }],
      authorTelegramUserId: "202",
      shown: [],
      chatKey: OTHER,
    });

    const shown = await guestChatRepository.summon(CHAT);
    expect(shown.map((note) => [note.content, note.dueOn, note.done])).toEqual([
      ["Падл с Максимом", null, false],
      ["Физтехи", "2026-10-16", false],
    ]);

    const applied = await guestChatRepository.apply({
      actions: [{ number: 1, type: "done" }, { number: 2, type: "forget" }, { number: 9, type: "done" }],
      authorTelegramUserId: "101",
      shown,
      chatKey: CHAT,
    });
    expect(applied).toEqual({ offerId: null, skipped: 1 });
    expect((await guestChatRepository.summon(CHAT)).map((note) => [note.content, note.done]))
      .toEqual([["Падл с Максимом", true]]);
    expect((await guestChatRepository.summon(OTHER)).map((note) => note.content)).toEqual(["Чужое"]);
  });

  it("offers a reminder until its time and forgets a chat entirely on request", async () => {
    await guestChatRepository.summon(CHAT);
    const { offerId } = await guestChatRepository.apply({
      actions: [
        { content: "Физтехи", dueOn: null, type: "remember" },
        { content: "Завтра физтехи", runAt: later(3), type: "reminder" },
      ],
      authorTelegramUserId: "101",
      shown: [],
      chatKey: CHAT,
    });
    expect(await guestChatRepository.findOffer(offerId!)).toMatchObject({ content: "Завтра физтехи", id: offerId });

    await guestChatRepository.apply({
      actions: [{ type: "forget_all" }],
      authorTelegramUserId: "202",
      shown: [],
      chatKey: CHAT,
    });
    expect(await guestChatRepository.summon(CHAT)).toEqual([]);
    expect(await guestChatRepository.findOffer(offerId!)).toBeNull();
  });

  it("purges chats not summoned for 90 days with their notes and passed offers", async () => {
    await guestChatRepository.summon(CHAT);
    await guestChatRepository.apply({
      actions: [{ content: "Старое", dueOn: null, type: "remember" }],
      authorTelegramUserId: "101",
      shown: [],
      chatKey: CHAT,
    });
    await guestChatRepository.summon(OTHER);
    await database().query(
      "UPDATE telegram_guest_chats SET last_summoned_at = now() - interval '91 days' WHERE chat_key = $1",
      [CHAT],
    );
    await database().query(
      `INSERT INTO telegram_guest_reminder_offers (chat_key, content, run_at, author_telegram_user_id)
       VALUES ($1, 'прошло', now() - interval '2 days', 202)`,
      [OTHER],
    );

    await expect(guestChatRepository.purgeExpired(new Date())).resolves.toBe(1);

    const notes = await database().query("SELECT 1 FROM telegram_guest_chat_notes");
    const offers = await database().query("SELECT 1 FROM telegram_guest_reminder_offers");
    expect(notes.rowCount).toBe(0);
    expect(offers.rowCount).toBe(0);
    expect(await guestChatRepository.summon(OTHER)).toEqual([]);
  });

  it("lists the newest notes once a chat has more than the prompt shows", async () => {
    await guestChatRepository.summon(CHAT);
    for (let batch = 0; batch < 9; batch += 1) {
      await guestChatRepository.apply({
        actions: Array.from({ length: 5 }, (_, index) => ({
          content: `дело ${batch * 5 + index + 1}`,
          dueOn: null,
          type: "remember" as const,
        })),
        authorTelegramUserId: "101",
        chatKey: CHAT,
        shown: [],
      });
    }

    const shown = await guestChatRepository.summon(CHAT);
    expect(shown).toHaveLength(40);
    expect(shown[0]!.content).toBe("дело 6");
    expect(shown.at(-1)!.content).toBe("дело 45");
  });
});
