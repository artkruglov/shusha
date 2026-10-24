/**
 * Webhook subscription check tests.
 *
 * Constructs covered:
 * - `ensureTelegramWebhookSubscription`: leaves a matching list alone; otherwise repeats `setWebhook`
 *   with the same URL, the agent's secret and the current `max_connections`, then confirms.
 * - A webhook the agent cannot have set (none, foreign path, custom certificate) is never touched.
 * - An IP in use that the host does not resolve to may be fixed by hand: no `setWebhook`, which would drop it.
 */
import { describe, expect, it, vi } from "vitest";

import { TELEGRAM_ALLOWED_UPDATES } from "./allowed-updates.js";
import { ensureTelegramWebhookSubscription } from "./webhook-subscription.js";

const URL_NOW = "https://relay.example.com/eve/v1/telegram";
const SECRET = "webhook_secret-0123456789abcdef0123456789";

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function info(result: Record<string, unknown>): Response {
  return answer({ ok: true, result: { has_custom_certificate: false, pending_update_count: 0, url: URL_NOW, ...result } });
}

function check(fetchMock: typeof fetch, resolveHost: (hostname: string) => Promise<readonly string[]> = async () => []) {
  return ensureTelegramWebhookSubscription({ botToken: "123:abc", fetch: fetchMock, resolveHost, secretToken: SECRET });
}

describe("ensureTelegramWebhookSubscription", () => {
  it("writes nothing when Telegram already sends every handled type, in any order", async () => {
    const fetchMock = vi.fn().mockResolvedValue(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES].reverse() }));

    await expect(check(fetchMock)).resolves.toBe("unchanged");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("subscribes an older installation to the missing type without moving or resetting its webhook", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(info({
        allowed_updates: ["message", "callback_query", "guest_message", "chat_join_request"],
        max_connections: 10,
        pending_update_count: 7,
      }))
      .mockResolvedValueOnce(answer({ ok: true, result: true }))
      .mockResolvedValueOnce(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES], max_connections: 10 }));

    await expect(check(fetchMock)).resolves.toBe("updated");

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.telegram.org/bot123:abc/setWebhook");
    const body = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toEqual({
      allowed_updates: ["message", "callback_query", "guest_message", "chat_join_request", "my_chat_member"],
      max_connections: 10,
      secret_token: SECRET,
      url: URL_NOW,
    });
    expect(body).not.toHaveProperty("drop_pending_updates");
  });

  it("treats an absent list (Telegram's default) as different and sets the explicit one", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(info({}))
      .mockResolvedValueOnce(answer({ ok: true, result: true }))
      .mockResolvedValueOnce(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES] }));

    await expect(check(fetchMock)).resolves.toBe("updated");
    const body = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("max_connections");
  });

  it.each([
    ["no_webhook", { url: "" }],
    ["foreign_url", { url: "https://bot.example.com/other/path" }],
    ["foreign_url", { url: "http://bot.example.com/eve/v1/telegram" }],
    ["custom_certificate", { has_custom_certificate: true }],
  ])("leaves a webhook it cannot have set alone (%s)", async (outcome, result) => {
    const fetchMock = vi.fn().mockResolvedValue(info({ allowed_updates: ["message"], ...result }));

    await expect(check(fetchMock)).resolves.toBe(outcome);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-registers without ip_address when the IP in use is one the host resolves to", async () => {
    const resolveHost = vi.fn(async () => ["2001:db8::1", "203.0.113.7"]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(info({ allowed_updates: ["message"], ip_address: "203.0.113.7" }))
      .mockResolvedValueOnce(answer({ ok: true, result: true }))
      .mockResolvedValueOnce(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES], ip_address: "203.0.113.7" }));

    await expect(check(fetchMock, resolveHost)).resolves.toBe("updated");

    expect(resolveHost).toHaveBeenCalledWith("relay.example.com");
    const body = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("ip_address");
  });

  it("leaves a webhook alone when the IP in use is not where the host resolves, or DNS does not answer", async () => {
    const pinned = vi.fn().mockResolvedValue(info({ allowed_updates: ["message"], ip_address: "198.51.100.9" }));
    await expect(check(pinned, async () => ["203.0.113.7"])).resolves.toBe("pinned_ip_address");
    expect(pinned).toHaveBeenCalledTimes(1);

    const unresolved = vi.fn().mockResolvedValue(info({ allowed_updates: ["message"], ip_address: "198.51.100.9" }));
    await expect(check(unresolved, async () => {
      throw new Error("ENOTFOUND");
    })).resolves.toBe("ip_address_unverified");
    expect(unresolved).toHaveBeenCalledTimes(1);
  });

  it("fails with a code when Telegram refuses or does not confirm the new list", async () => {
    const refused = vi.fn()
      .mockResolvedValueOnce(info({ allowed_updates: ["message"] }))
      .mockResolvedValueOnce(answer({ description: "Bad Request: bad webhook", ok: false }, 400));
    await expect(check(refused)).rejects.toMatchObject({ code: "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_FAILED" });

    const unconfirmed = vi.fn()
      .mockResolvedValueOnce(info({ allowed_updates: ["message"] }))
      .mockResolvedValueOnce(answer({ ok: true, result: true }))
      .mockResolvedValueOnce(info({ allowed_updates: ["message"] }));
    await expect(check(unconfirmed)).rejects.toMatchObject({ code: "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_UNCONFIRMED" });
  });

  it("refuses to run without a valid webhook secret", async () => {
    const fetchMock = vi.fn();
    await expect(ensureTelegramWebhookSubscription({ botToken: "123:abc", fetch: fetchMock, secretToken: "" }))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_CONFIG_MISSING" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
