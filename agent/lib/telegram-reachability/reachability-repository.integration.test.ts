/**
 * Telegram chat reachability repository tests (PostgreSQL, migration 199).
 *
 * Constructs covered:
 * - A delivery failure marks a chat and keeps its first moment; a message clears it.
 * - A 403 to a send that started before a message, an unblock or a return to the group was received
 *   is stale and marks nothing, also for a chat that had no row before the message.
 * - Updates apply in (Telegram date, update id) order, messages and membership changes alike: a delayed
 *   block never silences a chat that has written since, a later block wins even with a smaller id (ids
 *   restart at random after a quiet week), an equal date is decided by id, a repeated update changes nothing.
 * - The table refuses an empty chat id and an unknown reason.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { telegramReachabilityRepository as repository } from "./reachability-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

let next = Date.now() % 1_000_000_000;
const chatId = (group = false) => `${group ? "-100" : ""}${(next += 1)}`;
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 24, 6, 0, seconds));
// Telegram dates are whole seconds; the tests give them as seconds from a fixed moment.
const telegram = (seconds: number) => new Date(Date.UTC(2026, 9, 24, 5, 0, 0) + seconds * 1_000);
const message = (id: string, updateId: string, receivedSeconds: number, sentSeconds = receivedSeconds) =>
  repository.recordInboundMessage({ chatId: id, receivedAt: at(receivedSeconds), sentAt: telegram(sentSeconds), updateId });
const membership = (
  id: string, reason: "blocked" | "kicked" | "not_member" | null, updateId: string, receivedSeconds: number,
  changedSeconds = receivedSeconds,
) => repository.applyMembershipChange({ changedAt: telegram(changedSeconds), chatId: id, reason, receivedAt: at(receivedSeconds), updateId });

async function row(id: string) {
  return (await database().query<{ source: string; unreachable_reason: string | null; unreachable_since: Date | null }>(
    "SELECT source, unreachable_reason, unreachable_since FROM telegram_chat_reachability WHERE telegram_chat_id = $1",
    [id],
  )).rows[0];
}

describeWithDatabase("telegramReachabilityRepository", () => {
  afterAll(closeDatabase);

  it("marks a chat on a classified failure, keeps the first moment and clears it on a message", async () => {
    const id = chatId();
    await expect(repository.unreachableReason(id)).resolves.toBeNull();

    await expect(repository.markUndeliverable(id, "blocked", at(1))).resolves.toBe(true);
    const first = await row(id);
    await expect(repository.markUndeliverable(id, "deactivated", at(2))).resolves.toBe(true);

    expect(await row(id)).toEqual({ source: "delivery", unreachable_reason: "deactivated", unreachable_since: first!.unreachable_since });
    await expect(repository.unreachableReason(id)).resolves.toBe("deactivated");
    await expect(message(id, "100", 3)).resolves.toEqual({ cleared: true });
    await expect(message(id, "101", 4)).resolves.toEqual({ cleared: false });
    expect(await row(id)).toMatchObject({ source: "inbound_message", unreachable_reason: null, unreachable_since: null });
  });

  it("ignores a 403 to a send that started before a message from the chat was received", async () => {
    const id = chatId();
    // The send left at :10, the person wrote at :11 (the chat had no row), the old 403 came at :12.
    await expect(message(id, "200", 11)).resolves.toEqual({ cleared: false });
    await expect(repository.markUndeliverable(id, "blocked", at(10))).resolves.toBe(false);
    await expect(repository.unreachableReason(id)).resolves.toBeNull();
    // A send that started after that message is Telegram's newer word.
    await expect(repository.markUndeliverable(id, "blocked", at(12))).resolves.toBe(true);
    await expect(repository.unreachableReason(id)).resolves.toBe("blocked");
  });

  it("ignores a 403 to a send that started before an unblock or a return to the group was received", async () => {
    const person = chatId();
    await membership(person, "blocked", "300", 1);
    await membership(person, null, "301", 6);
    await expect(repository.markUndeliverable(person, "blocked", at(4))).resolves.toBe(false);
    await expect(repository.unreachableReason(person)).resolves.toBeNull();

    const group = chatId(true);
    await membership(group, null, "302", 8);
    await expect(repository.markUndeliverable(group, "kicked", at(7))).resolves.toBe(false);
    await expect(repository.markUndeliverable(group, "kicked", at(9))).resolves.toBe(true);
  });

  it("keeps a chat reachable when a block dated before its last message arrives late", async () => {
    const id = chatId();
    // (а) message date 100, update 20; then a block dated 99, update 19.
    await expect(message(id, "20", 30, 100)).resolves.toEqual({ cleared: false });
    await expect(membership(id, "blocked", "19", 31, 99)).resolves.toBe(false);
    await expect(repository.unreachableReason(id)).resolves.toBeNull();
  });

  it("applies a later block even when its update id is smaller", async () => {
    const id = chatId();
    // (б) message date 100, update 500; then a block dated 101 with update 7 (ids restarted after a quiet week).
    await expect(message(id, "500", 30, 100)).resolves.toEqual({ cleared: false });
    await expect(membership(id, "blocked", "7", 31, 101)).resolves.toBe(true);
    await expect(repository.unreachableReason(id)).resolves.toBe("blocked");
  });

  it("decides an equal date by update id", async () => {
    const id = chatId(true);
    // (в) removal and message share date 200: the larger update id is the later event.
    await expect(membership(id, "kicked", "50", 40, 200)).resolves.toBe(true);
    await expect(message(id, "49", 41, 200)).resolves.toBeNull();
    await expect(message(id, "50", 42, 200)).resolves.toBeNull();
    await expect(repository.unreachableReason(id)).resolves.toBe("kicked");
    await expect(message(id, "51", 43, 200)).resolves.toEqual({ cleared: true });
    await expect(repository.unreachableReason(id)).resolves.toBeNull();
  });

  it("applies membership changes in Telegram's order, whatever order they arrive in", async () => {
    const id = chatId(true);

    // The bot came back (date 20) after a removal (date 10); the removal is delivered last.
    await expect(membership(id, null, "20", 20)).resolves.toBe(true);
    await expect(membership(id, "kicked", "10", 21, 10)).resolves.toBe(false);
    await expect(repository.unreachableReason(id)).resolves.toBeNull();

    await expect(membership(id, "not_member", "30", 30)).resolves.toBe(true);
    // A repeated delivery of the same update is not newer than itself.
    await expect(membership(id, "not_member", "30", 31, 30)).resolves.toBe(false);
    await expect(repository.unreachableReason(id)).resolves.toBe("not_member");
    expect(await row(id)).toMatchObject({ source: "membership_update" });
  });

  it("refuses an empty chat id and an unknown reason", async () => {
    await expect(repository.markUndeliverable("", "blocked", at(0))).rejects.toThrow();
    await expect(repository.markUndeliverable(chatId(), "gone" as never, at(0))).rejects.toThrow();
  });
});
