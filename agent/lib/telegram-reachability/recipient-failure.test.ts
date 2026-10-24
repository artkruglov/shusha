/**
 * Classification of Telegram's answers about a chat that can no longer receive messages.
 *
 * Constructs covered:
 * - `classifyTelegramRecipientFailure`: the six recipient answers by status and whole description; every
 *   other failure, a migrated group included, stays unclassified.
 * - `telegramProviderDescription`: Telegram's description cut to 200 characters.
 */
import { describe, expect, it } from "vitest";

import { classifyTelegramRecipientFailure, telegramProviderDescription } from "./recipient-failure.js";

const answer = (error_code: number, description: string, parameters?: Record<string, unknown>) =>
  ({ description, error_code, ok: false, ...(parameters ? { parameters } : {}) });

describe("classifyTelegramRecipientFailure", () => {
  it.each([
    [403, "Forbidden: bot was blocked by the user", "blocked"],
    [403, "Forbidden: user is deactivated", "deactivated"],
    [403, "Forbidden: bot was kicked from the group chat", "kicked"],
    [403, "Forbidden: bot was kicked from the supergroup chat", "kicked"],
    [403, "Forbidden: bot was kicked from the channel chat", "kicked"],
    [403, "Forbidden: bot is not a member of the group chat", "not_member"],
    [403, "Forbidden: bot is not a member of the supergroup chat", "not_member"],
    [403, "Forbidden: bot can't initiate conversation with a user", "not_started"],
    [400, "Bad Request: chat not found", "not_found"],
  ])("reads %s %s as %s", (status, description, reason) => {
    expect(classifyTelegramRecipientFailure(status, answer(status, description))).toBe(reason);
  });

  it.each([
    [400, answer(400, "Bad Request: group chat was upgraded to a supergroup chat", { migrate_to_chat_id: -1001 })],
    [400, answer(400, "Bad Request: message thread not found")],
    [400, answer(400, "Bad Request: not enough rights to send text messages to the chat")],
    [403, answer(403, "Forbidden: bot can't send messages to bots")],
    [403, answer(400, "Forbidden: bot was blocked by the user")],
    [400, answer(400, "Bad Request: chat not found, maybe")],
    [429, answer(429, "Too Many Requests: retry after 5", { retry_after: 5 })],
    [502, "Bad Gateway"],
    [403, null],
  ])("leaves %s %j unclassified", (status, body) => {
    expect(classifyTelegramRecipientFailure(status, body)).toBeNull();
  });

  it("uses the HTTP status when the answer carries no error_code", () => {
    expect(classifyTelegramRecipientFailure(403, { description: "Forbidden: user is deactivated", ok: false }))
      .toBe("deactivated");
  });
});

describe("telegramProviderDescription", () => {
  it("bounds the description and ignores a body without one", () => {
    expect(telegramProviderDescription({ description: "x".repeat(500) })).toHaveLength(200);
    expect(telegramProviderDescription("Bad Gateway")).toBeNull();
  });
});
