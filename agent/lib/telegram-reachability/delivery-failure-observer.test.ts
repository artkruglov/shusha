/**
 * Delivery failure observer tests.
 *
 * Constructs covered:
 * - `recordTelegramDeliveryFailure`: marks a chat Telegram calls gone and logs codes and ids only; an
 *   answer older than a proof of reachability is logged as stale.
 * - `installTelegramDeliveryFailureObserver`: registers the recorder where the send pacer looks for it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { installTelegramDeliveryFailureObserver, recordTelegramDeliveryFailure } from "./delivery-failure-observer.js";

const OBSERVER_KEY = Symbol.for("osinara.telegramDeliveryFailureObserver");

describe("recordTelegramDeliveryFailure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { [key: symbol]: unknown })[OBSERVER_KEY];
  });

  it("marks a blocked private chat and logs the bounded provider description", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repository = { markUndeliverable: vi.fn().mockResolvedValue(true) };

    await expect(recordTelegramDeliveryFailure({
      body: { description: "Forbidden: bot was blocked by the user", error_code: 403, ok: false },
      chatId: "101", method: "sendMessage", startedAt: 1_760_000_000_123, status: 403,
    }, repository)).resolves.toBe("blocked");

    expect(repository.markUndeliverable).toHaveBeenCalledWith("101", "blocked", new Date(1_760_000_000_123));
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      chatId: "101",
      code: "AGENT_TELEGRAM_RECIPIENT_UNREACHABLE",
      method: "sendMessage",
      providerDescription: "Forbidden: bot was blocked by the user",
      providerStatus: 403,
      reason: "blocked",
    });
  });

  it("logs a stale answer under its own code when the repository kept the chat reachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repository = { markUndeliverable: vi.fn().mockResolvedValue(false) };

    await recordTelegramDeliveryFailure({
      body: { description: "Forbidden: bot was blocked by the user", ok: false },
      chatId: "101", method: "sendMessage", startedAt: 1, status: 403,
    }, repository);

    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      chatId: "101", code: "AGENT_TELEGRAM_RECIPIENT_UNREACHABLE_STALE", reason: "blocked",
    });
  });

  it("leaves any other failure alone", async () => {
    const repository = { markUndeliverable: vi.fn() };
    await expect(recordTelegramDeliveryFailure({
      body: { description: "Bad Request: message is too long", error_code: 400, ok: false },
      chatId: "101", method: "sendMessage", startedAt: 1, status: 400,
    }, repository)).resolves.toBeNull();
    expect(repository.markUndeliverable).not.toHaveBeenCalled();
  });

  it("registers a function under the key the send pacer reads", () => {
    installTelegramDeliveryFailureObserver();
    expect(typeof (globalThis as { [key: symbol]: unknown })[OBSERVER_KEY]).toBe("function");
  });
});
