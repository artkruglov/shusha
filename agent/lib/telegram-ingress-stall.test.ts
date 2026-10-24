/**
 * Ingress stall alert dispatch tests.
 *
 * Constructs covered:
 * - Each newly stalled message reaches every owner once, with where and since when it waits.
 * - A stalled guest message is named as guest mode, not as a group.
 * - Nothing is sent when no message is stalled.
 */
import { describe, expect, it, vi } from "vitest";

import { dispatchIngressStallAlerts } from "./telegram-ingress-stall.js";

describe("ingress stall alerts", () => {
  it("tells every owner about each stalled message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deliver = vi.fn(async () => undefined);
    const sent = await dispatchIngressStallAlerts({
      claim: async () => [{ chatType: "private", receivedAt: new Date("2026-10-01T22:22:00Z"), updateId: "85052827" }],
      deliver,
      now: () => new Date("2026-10-01T23:02:00Z"),
      recipients: async () => [{ familyId: "f", ownerTelegramUserId: "101", quietEnd: null, quietStart: null, timezone: "UTC" }],
    });

    expect(sent).toBe(1);
    expect(deliver).toHaveBeenCalledWith({
      chatId: "101",
      text: expect.stringMatching(/в личном чате уже 40 мин \(пришло в 22:22 UTC\)/u),
    });
  });

  it("names a stalled guest message as guest mode", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deliver = vi.fn(async () => undefined);
    await dispatchIngressStallAlerts({
      claim: async () => [{ chatType: "guest", receivedAt: new Date("2026-10-01T22:22:00Z"), updateId: "1" }],
      deliver,
      now: () => new Date("2026-10-01T23:02:00Z"),
      recipients: async () => [{ familyId: "f", ownerTelegramUserId: "101", quietEnd: null, quietStart: null, timezone: "UTC" }],
    });

    expect(deliver).toHaveBeenCalledWith({ chatId: "101", text: expect.stringContaining("в гостевом режиме") });
  });

  it("sends nothing when no message is stalled", async () => {
    const deliver = vi.fn();
    const recipients = vi.fn(async () => [{ familyId: "f", ownerTelegramUserId: "101", quietEnd: null, quietStart: null, timezone: "UTC" }]);
    await expect(dispatchIngressStallAlerts({ claim: async () => [], deliver, recipients })).resolves.toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("does not stamp a stall as alerted while no owner can be reached, and alerts once one can", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const claim = vi.fn(async () => [{ chatType: "private", receivedAt: new Date("2026-10-01T22:22:00Z"), updateId: "7" }]);
    const deliver = vi.fn(async () => undefined);
    const recipients = async () => [{ familyId: "f", ownerTelegramUserId: "101", quietEnd: null, quietStart: null, timezone: "UTC" }];

    await expect(dispatchIngressStallAlerts({ claim, deliver, recipients, unreachable: async () => true })).resolves.toBe(0);
    expect(claim).not.toHaveBeenCalled();

    await expect(dispatchIngressStallAlerts({ claim, deliver, recipients, unreachable: async () => false })).resolves.toBe(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ chatId: "101" }));
  });
});
