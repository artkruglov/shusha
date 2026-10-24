/**
 * `my_chat_member` hook tests.
 *
 * Constructs covered:
 * - `parseMyChatMemberUpdate`: private block/unblock and group removal/return per Bot API 10.3 statuses.
 * - `createMyChatMemberHook`: applies the change before answering 200; an unreadable update is
 *   acknowledged without a write; a failed write is thrown, so Telegram delivers the update again.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMyChatMemberHook, parseMyChatMemberUpdate } from "./my-chat-member.js";

function update(chat: Record<string, unknown>, newMember: Record<string, unknown>, updateId = 501) {
  return {
    my_chat_member: {
      chat,
      date: 1_760_000_000,
      from: { first_name: "Анна", id: 101, is_bot: false },
      new_chat_member: { user: { first_name: "Шуша", id: 7, is_bot: true }, ...newMember },
      old_chat_member: { status: "member", user: { first_name: "Шуша", id: 7, is_bot: true } },
    },
    update_id: updateId,
  };
}

const privateChat = { first_name: "Анна", id: 101, type: "private" };
const group = { id: -1001, title: "Семья", type: "supergroup" };

describe("parseMyChatMemberUpdate", () => {
  it.each([
    [privateChat, { status: "kicked", until_date: 0 }, "blocked"],
    [privateChat, { status: "member" }, null],
    [group, { status: "kicked", until_date: 0 }, "kicked"],
    [group, { status: "left" }, "not_member"],
    [group, { status: "restricted", is_member: false }, "not_member"],
    [group, { status: "restricted", is_member: true }, null],
    [group, { status: "member" }, null],
    [group, { status: "administrator" }, null],
  ])("reads %j with %j as %s", (chat, member, reason) => {
    expect(parseMyChatMemberUpdate(update(chat, member))).toEqual({
      changedAt: new Date(1_760_000_000_000),
      chatId: String(chat.id),
      chatType: chat.type,
      reason,
      status: member.status,
      updateId: "501",
    });
  });

  it("returns null for another update, a malformed one or a status that says nothing", () => {
    expect(parseMyChatMemberUpdate({ message: { chat: privateChat }, update_id: 1 })).toBeNull();
    expect(parseMyChatMemberUpdate({ my_chat_member: { chat: privateChat }, update_id: 1 })).toBeNull();
    expect(parseMyChatMemberUpdate(update({ id: "101", type: "private" }, { status: "kicked" }))).toBeNull();
    expect(parseMyChatMemberUpdate(update(privateChat, { status: "left" }))).toBeNull();
  });
});

describe("createMyChatMemberHook", () => {
  afterEach(() => vi.restoreAllMocks());

  it("marks a blocked bot before answering Telegram and logs ids and codes only", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const repository = { applyMembershipChange: vi.fn().mockResolvedValue(true) };
    const receivedAt = new Date("2026-10-24T06:00:00.000Z");

    const response = await createMyChatMemberHook(repository, () => receivedAt)({ raw: update(privateChat, { status: "kicked" }) as never });

    expect(response.status).toBe(200);
    expect(repository.applyMembershipChange).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "101", reason: "blocked", receivedAt, updateId: "501",
    }));
    const logged = String(info.mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toMatchObject({ applied: true, chatId: "101", code: "AGENT_TELEGRAM_RECIPIENT_UNREACHABLE" });
    expect(logged).not.toContain("Анна");
    expect(logged).not.toContain("Семья");
  });

  it("acknowledges an unreadable update without writing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repository = { applyMembershipChange: vi.fn() };
    const response = await createMyChatMemberHook(repository)({ raw: { my_chat_member: {}, update_id: 9 } as never });
    expect(response.status).toBe(200);
    expect(repository.applyMembershipChange).not.toHaveBeenCalled();
  });

  it("lets a failed write fail the webhook, so Telegram delivers the update again", async () => {
    const repository = { applyMembershipChange: vi.fn().mockRejectedValue(new Error("database down")) };
    await expect(createMyChatMemberHook(repository)({ raw: update(group, { status: "member" }) as never }))
      .rejects.toThrow("database down");
  });
});
