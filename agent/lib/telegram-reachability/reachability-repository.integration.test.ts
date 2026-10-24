/**
 * Telegram chat reachability repository tests (PostgreSQL, migration 199).
 *
 * Constructs covered:
 * - A delivery failure marks a chat and keeps its first moment; a message clears it.
 * - A 403 to a send that started before a message, an unblock or a return to the group was received
 *   is stale and marks nothing, also for a chat that had no row before the message.
 * - `my_chat_member` marks and clears in update order: an older or repeated update changes nothing.
 * - A message not newer than the last membership change (by date, then by update id) clears nothing.
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
const message = (id: string, sentSeconds: number, updateId: string, receivedSeconds = sentSeconds) =>
  repository.recordInboundMessage({ chatId: id, receivedAt: at(receivedSeconds), sentAt: at(sentSeconds), updateId });

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
    await expect(message(id, 3, "100")).resolves.toEqual({ cleared: true });
    await expect(message(id, 4, "101")).resolves.toEqual({ cleared: false });
    expect(await row(id)).toMatchObject({ source: "inbound_message", unreachable_reason: null, unreachable_since: null });
  });

  it("ignores a 403 to a send that started before a message from the chat was received", async () => {
    const id = chatId();
    // The send left at :10, the person wrote at :11 (the chat had no row), the old 403 came at :12.
    await expect(message(id, 11, "200")).resolves.toEqual({ cleared: false });
    await expect(repository.markUndeliverable(id, "blocked", at(10))).resolves.toBe(false);
    await expect(repository.unreachableReason(id)).resolves.toBeNull();
    // A send that started after that message is Telegram's newer word.
    await expect(repository.markUndeliverable(id, "blocked", at(12))).resolves.toBe(true);
    await expect(repository.unreachableReason(id)).resolves.toBe("blocked");
  });

  it("ignores a 403 to a send that started before an unblock or a return to the group was received", async () => {
    const person = chatId();
    await repository.applyMembershipChange({ changedAt: at(1), chatId: person, reason: "blocked", receivedAt: at(1), updateId: "300" });
    await repository.applyMembershipChange({ changedAt: at(5), chatId: person, reason: null, receivedAt: at(6), updateId: "301" });
    await expect(repository.markUndeliverable(person, "blocked", at(4))).resolves.toBe(false);
    await expect(repository.unreachableReason(person)).resolves.toBeNull();

    const group = chatId(true);
    await repository.applyMembershipChange({ changedAt: at(7), chatId: group, reason: null, receivedAt: at(8), updateId: "302" });
    await expect(repository.markUndeliverable(group, "kicked", at(7))).resolves.toBe(false);
    await expect(repository.markUndeliverable(group, "kicked", at(9))).resolves.toBe(true);
  });

  it("applies membership changes in Telegram's order, whatever order they arrive in", async () => {
    const id = chatId(true);

    // The bot came back at :05 after a removal at :01; the removal is delivered last.
    await expect(repository.applyMembershipChange({ changedAt: at(5), chatId: id, reason: null, receivedAt: at(20), updateId: "20" })).resolves.toBe(true);
    await expect(repository.applyMembershipChange({ changedAt: at(1), chatId: id, reason: "kicked", receivedAt: at(21), updateId: "10" })).resolves.toBe(false);
    await expect(repository.unreachableReason(id)).resolves.toBeNull();

    await expect(repository.applyMembershipChange({ changedAt: at(9), chatId: id, reason: "not_member", receivedAt: at(22), updateId: "30" })).resolves.toBe(true);
    // A repeated delivery of the same update is not newer than itself.
    await expect(repository.applyMembershipChange({ changedAt: at(9), chatId: id, reason: "not_member", receivedAt: at(23), updateId: "30" })).resolves.toBe(false);
    await expect(repository.unreachableReason(id)).resolves.toBe("not_member");
    expect(await row(id)).toMatchObject({ source: "membership_update" });

    // A message written before that removal proves nothing about it; one written after does.
    await expect(message(id, 8, "29", 24)).resolves.toBeNull();
    await expect(message(id, 10, "31", 25)).resolves.toEqual({ cleared: true });
    await expect(repository.unreachableReason(id)).resolves.toBeNull();
  });

  it("orders a message with the same date as the removal by update id", async () => {
    const id = chatId(true);
    await repository.applyMembershipChange({ changedAt: at(30), chatId: id, reason: "kicked", receivedAt: at(30), updateId: "500" });

    await expect(message(id, 30, "499")).resolves.toBeNull();
    await expect(message(id, 30, "500")).resolves.toBeNull();
    await expect(repository.unreachableReason(id)).resolves.toBe("kicked");
    await expect(message(id, 30, "501")).resolves.toEqual({ cleared: true });
  });

  it("refuses an empty chat id and an unknown reason", async () => {
    await expect(repository.markUndeliverable("", "blocked", at(0))).rejects.toThrow();
    await expect(repository.markUndeliverable(chatId(), "gone" as never, at(0))).rejects.toThrow();
  });
});
