/**
 * Turn interjection delivery record tests.
 *
 * Constructs covered:
 * - An eligible turn records each model step with its index and settles at the end of the turn;
 *   other turns never touch the table.
 * - A failed record is retried once, logged, and never fails the person's turn.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { finishTurnInterjectionDelivery, isTurnInterjectionDeliveryUntracked, recordTurnInterjectionDelivery } from "./turn-interjection-delivery.js";

function context(attributes: Record<string, unknown>) {
  return {
    session: {
      auth: {
        current: {
          attributes: {
            applicationSessionId: "00000000-0000-4000-8000-0000000000a1",
            osinaraTelegramUpdateId: "500",
            telegramActorKind: "telegram_user",
            telegramChatId: "101",
            telegramChatType: "private",
            telegramTurnInterjectionMarker: "0123456789abcdef01234567",
            telegramUserId: "101",
            ...attributes,
          },
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user" as const,
        },
        initiator: null,
      },
      id: "ses_1",
      turn: { id: "turn_2" },
    },
  };
}

const repository = () => ({ finishTurn: vi.fn(async () => 0), stepStarted: vi.fn(async () => 1) });

afterEach(() => vi.restoreAllMocks());

describe("turn interjection delivery", () => {
  it("records the model step by its index and settles the turn at its end", async () => {
    const repo = repository();
    await recordTurnInterjectionDelivery(context({}), 3, repo);
    expect(repo.stepStarted).toHaveBeenCalledWith("ses_1", "turn_2", 3);
    await finishTurnInterjectionDelivery(context({}), repo);
    expect(repo.finishTurn).toHaveBeenCalledWith("ses_1", "turn_2");
  });

  it("ignores a turn that cannot receive messages meanwhile", async () => {
    const repo = repository();
    await recordTurnInterjectionDelivery(context({ telegramTurnInterjectionMarker: undefined }), 1, repo);
    await finishTurnInterjectionDelivery(context({ telegramTurnInterjectionMarker: undefined }), repo);
    expect(repo.stepStarted).not.toHaveBeenCalled();
    expect(repo.finishTurn).not.toHaveBeenCalled();
  });

  it("retries a failed record once and never fails the turn", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const repo = repository();
    repo.stepStarted.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(recordTurnInterjectionDelivery(context({}), 2, repo)).resolves.toBeUndefined();
    expect(repo.stepStarted).toHaveBeenCalledTimes(2);
    repo.finishTurn.mockRejectedValue(new Error("database unavailable"));
    await expect(finishTurnInterjectionDelivery(context({}), repo)).resolves.toBeUndefined();
    expect(repo.finishTurn).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map((call) => JSON.parse(String(call[0])).code)).toEqual(Array(3).fill("AGENT_TURN_INTERJECTION_DELIVERY_RECORD_FAILED"));
  });

  // Codex review of 1.7.3: a result returned while the step was unrecorded passed for delivered on a retry.
  it("stops showing new messages to a turn whose step could not be recorded, until one is", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const repo = repository();
    const ctx = context({});
    repo.stepStarted.mockRejectedValueOnce(new Error("down")).mockRejectedValueOnce(new Error("down"));
    await recordTurnInterjectionDelivery(ctx, 4, repo);
    expect(isTurnInterjectionDeliveryUntracked(ctx)).toBe(true);
    await recordTurnInterjectionDelivery(ctx, 5, repo);
    expect(isTurnInterjectionDeliveryUntracked(ctx)).toBe(false);
  });
});
