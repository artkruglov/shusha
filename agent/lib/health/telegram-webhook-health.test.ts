/**
 * Webhook health reader tests.
 *
 * Constructs covered:
 * - `readTelegramWebhookHealth`: reads `WebhookInfo` fields as Telegram names them and never throws.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { readTelegramWebhookHealth } from "./telegram-webhook-health.js";

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

describe("readTelegramWebhookHealth", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads pending updates and the last delivery error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer({
      ok: true,
      result: {
        has_custom_certificate: false,
        last_error_date: 1_760_000_000,
        last_error_message: "Connection timed out",
        pending_update_count: 151,
        url: "https://bot.example.com/eve/v1/telegram",
      },
    }));

    await expect(readTelegramWebhookHealth({ botToken: "123:abc", fetch: fetchMock })).resolves.toEqual({
      lastErrorAt: new Date(1_760_000_000_000),
      lastErrorMessage: "Connection timed out",
      pendingUpdateCount: 151,
      status: "read",
      url: "https://bot.example.com/eve/v1/telegram",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.telegram.org/bot123:abc/getWebhookInfo");
  });

  it("turns a failed call, a refusal and a malformed answer into an unreadable check with a code", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const fetchMock of [
      vi.fn().mockRejectedValue(new Error("network down")),
      vi.fn().mockResolvedValue(answer({ description: "Unauthorized", ok: false }, 401)),
      vi.fn().mockResolvedValue(answer({ ok: true, result: { url: "x" } })),
    ]) {
      await expect(readTelegramWebhookHealth({ botToken: "123:abc", fetch: fetchMock }))
        .resolves.toEqual({ status: "unreadable" });
    }
    await expect(readTelegramWebhookHealth({ botToken: undefined })).resolves.toEqual({ status: "unreadable" });
    const reasons = errors.mock.calls.map(([line]) => (JSON.parse(String(line)) as { reason: string }).reason);
    expect(reasons).toEqual([
      "AGENT_TELEGRAM_WEBHOOK_INFO_UNAVAILABLE",
      "AGENT_TELEGRAM_WEBHOOK_INFO_UNAVAILABLE",
      "AGENT_TELEGRAM_WEBHOOK_INFO_INVALID",
      "AGENT_TELEGRAM_CONFIG_MISSING",
    ]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("123:abc");
  });
});
