/**
 * Reachability guard tests.
 *
 * Constructs covered:
 * - `unreachableTelegramRecipient`: a marked chat is skipped with a log of id, kind and reason only.
 * - `noteInboundTelegramMessage`: a message is recorded as proof with its date, update id and receipt
 *   time; the service message about the bot's own removal is not proof; a failed write is logged and
 *   never thrown.
 * - `isTelegramBotItself`: the bot is recognized by the id in its token, or by its username.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { isTelegramBotItself, noteInboundTelegramMessage, unreachableTelegramRecipient } from "./reachability-guard.js";

const self = { id: "7000", username: "shusha_bot" };
const receivedAt = new Date("2026-10-24T06:00:00.000Z");

describe("unreachableTelegramRecipient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the reason of a marked chat and logs the skip without any text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repository = { unreachableReason: vi.fn().mockResolvedValue("blocked") };

    await expect(unreachableTelegramRecipient("101", "reminder", repository)).resolves.toBe("blocked");

    expect(repository.unreachableReason).toHaveBeenCalledWith("101");
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      chatId: "101", code: "AGENT_TELEGRAM_PROACTIVE_DELIVERY_SKIPPED", kind: "reminder", reason: "blocked",
    });
  });

  it("lets a reachable chat through silently and propagates a failed lookup", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(unreachableTelegramRecipient("101", "errand", { unreachableReason: vi.fn().mockResolvedValue(null) }))
      .resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    await expect(unreachableTelegramRecipient("101", "errand", {
      unreachableReason: vi.fn().mockRejectedValue(new Error("connection terminated")),
    })).rejects.toThrow("connection terminated");
  });
});

describe("isTelegramBotItself", () => {
  it("matches the bot by the id in its token, or by username when the id is unknown", () => {
    expect(isTelegramBotItself({ first_name: "Шуша", id: 7000, is_bot: true }, self)).toBe(true);
    expect(isTelegramBotItself({ id: 7001, is_bot: true, username: "shusha_bot" }, self)).toBe(false);
    expect(isTelegramBotItself({ id: 7000, is_bot: false }, self)).toBe(false);
    expect(isTelegramBotItself({ id: 9, is_bot: true, username: "Shusha_Bot" }, { id: null, username: "shusha_bot" })).toBe(true);
    expect(isTelegramBotItself(undefined, self)).toBe(false);
  });
});

describe("noteInboundTelegramMessage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("records the message's date, update id and receipt time and logs only a cleared mark", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const repository = {
      recordInboundMessage: vi.fn().mockResolvedValueOnce({ cleared: true }).mockResolvedValueOnce({ cleared: false }),
    };
    const message = { chat: { id: -1001, type: "supergroup" }, date: 1_700_000_000, message_id: 5, text: "привет" };

    await noteInboundTelegramMessage({ chatId: "-1001", message, updateId: "900" }, { now: () => receivedAt, repository, self });
    await noteInboundTelegramMessage({ chatId: "-1001", message, updateId: "901" }, { now: () => receivedAt, repository, self });

    expect(repository.recordInboundMessage).toHaveBeenNthCalledWith(1, {
      chatId: "-1001", receivedAt, sentAt: new Date(1_700_000_000_000), updateId: "900",
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual({
      chatId: "-1001", code: "AGENT_TELEGRAM_RECIPIENT_REACHABLE", source: "inbound_message",
    });
    expect(String(info.mock.calls[0]?.[0])).not.toContain("привет");
  });

  it("never takes the service message about the bot's own removal as proof, but does take another member's", async () => {
    const repository = { recordInboundMessage: vi.fn().mockResolvedValue({ cleared: false }) };
    const removed = (member: Record<string, unknown>) => ({
      chat: { id: -1001, type: "supergroup" }, date: 1_760_000_000, left_chat_member: member, message_id: 6,
    });

    await noteInboundTelegramMessage({ chatId: "-1001", message: removed({ id: 7000, is_bot: true, username: "shusha_bot" }), updateId: "902" },
      { now: () => receivedAt, repository, self });
    expect(repository.recordInboundMessage).not.toHaveBeenCalled();

    await noteInboundTelegramMessage({ chatId: "-1001", message: removed({ first_name: "Анна", id: 101, is_bot: false }), updateId: "903" },
      { now: () => receivedAt, repository, self });
    expect(repository.recordInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("never throws when the write fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(noteInboundTelegramMessage({ chatId: "101", message: {}, updateId: "904" }, {
      repository: { recordInboundMessage: vi.fn().mockRejectedValue(new Error("database down")) }, self,
    })).resolves.toBeUndefined();
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      chatId: "101", code: "AGENT_TELEGRAM_REACHABILITY_CLEAR_FAILED", errorName: "Error",
    });
  });
});
