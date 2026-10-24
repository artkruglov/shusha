/**
 * Webhook subscription check tests.
 *
 * Constructs covered:
 * - `ensureTelegramWebhookSubscription`: leaves a matching webhook alone; otherwise repeats `setWebhook`
 *   for the expected URL with the agent's secret and the current `max_connections`, then confirms.
 * - Only the exact `PUBLIC_BASE_URL` plus the route is the agent's webhook: another host with the same path
 *   never receives the secret, and without a valid `PUBLIC_BASE_URL` nothing is changed.
 * - The IP is fixed only by `TELEGRAM_WEBHOOK_IP_ADDRESS`; the reported IP in use never decides anything.
 * - `telegramWebhookUrl`, `parseTelegramWebhookIpAddress`: the shared builders of installer and agent.
 */
import { describe, expect, it, vi } from "vitest";

import { parseTelegramWebhookIpAddress, TELEGRAM_ALLOWED_UPDATES, telegramWebhookUrl } from "./webhook-registration.js";
import { ensureTelegramWebhookSubscription } from "./webhook-subscription.js";

const BASE = "https://bot.example.com/";
const URL_NOW = "https://bot.example.com/eve/v1/telegram";
const SECRET = "webhook_secret-0123456789abcdef0123456789";

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function info(result: Record<string, unknown>): Response {
  return answer({ ok: true, result: { has_custom_certificate: false, pending_update_count: 0, url: URL_NOW, ...result } });
}

function check(fetchMock: typeof fetch, extra: { ipAddress?: string; publicBaseUrl?: string | undefined } = {}) {
  return ensureTelegramWebhookSubscription({
    botToken: "123:abc", fetch: fetchMock, publicBaseUrl: BASE, secretToken: SECRET, ...extra,
  });
}

function setWebhookBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)) as Record<string, unknown>;
}

describe("telegramWebhookUrl and parseTelegramWebhookIpAddress", () => {
  it("builds the webhook from a bare https origin, with or without the trailing slash", () => {
    expect(telegramWebhookUrl("https://bot.example.com")).toBe(URL_NOW);
    expect(telegramWebhookUrl("https://Bot.Example.com/")).toBe(URL_NOW);
    for (const invalid of [undefined, "", "not a url", "http://bot.example.com", "https://bot.example.com/sub/", "https://bot.example.com/?a=1"]) {
      expect(telegramWebhookUrl(invalid)).toBeNull();
    }
  });

  it("accepts an IPv4 or IPv6 address, treats absence as none and refuses anything else", () => {
    expect(parseTelegramWebhookIpAddress(undefined)).toBeNull();
    expect(parseTelegramWebhookIpAddress(" ")).toBeNull();
    expect(parseTelegramWebhookIpAddress("203.0.113.7")).toBe("203.0.113.7");
    expect(parseTelegramWebhookIpAddress("2001:db8::1")).toBe("2001:db8::1");
    expect(() => parseTelegramWebhookIpAddress("bot.example.com")).toThrow("AGENT_TELEGRAM_WEBHOOK_IP_ADDRESS_INVALID");
  });
});

describe("ensureTelegramWebhookSubscription", () => {
  it("writes nothing when Telegram already sends every handled type, in any order", async () => {
    const fetchMock = vi.fn().mockResolvedValue(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES].reverse(), ip_address: "198.51.100.1" }));

    await expect(check(fetchMock)).resolves.toBe("unchanged");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("subscribes an older installation to the missing type without fixing an IP or resetting its webhook", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(info({
        allowed_updates: ["message", "callback_query", "guest_message", "chat_join_request"],
        ip_address: "198.51.100.1",
        max_connections: 10,
        pending_update_count: 7,
      }))
      .mockResolvedValueOnce(answer({ ok: true, result: true }))
      .mockResolvedValueOnce(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES], max_connections: 10 }));

    await expect(check(fetchMock)).resolves.toBe("updated");

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.telegram.org/bot123:abc/setWebhook");
    expect(setWebhookBody(fetchMock)).toEqual({
      allowed_updates: ["message", "callback_query", "guest_message", "chat_join_request", "my_chat_member"],
      max_connections: 10,
      secret_token: SECRET,
      url: URL_NOW,
    });
  });

  it("fixes the IP only from TELEGRAM_WEBHOOK_IP_ADDRESS, and re-registers a webhook delivering elsewhere", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES], ip_address: "198.51.100.1" }))
      .mockResolvedValueOnce(answer({ ok: true, result: true }))
      .mockResolvedValueOnce(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES], ip_address: "203.0.113.7" }));

    await expect(check(fetchMock, { ipAddress: "203.0.113.7" })).resolves.toBe("updated");
    expect(setWebhookBody(fetchMock)).toMatchObject({ ip_address: "203.0.113.7", url: URL_NOW });

    const steady = vi.fn().mockResolvedValue(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES], ip_address: "203.0.113.7" }));
    await expect(check(steady, { ipAddress: "203.0.113.7" })).resolves.toBe("unchanged");

    await expect(check(vi.fn(), { ipAddress: "not-an-ip" }))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_WEBHOOK_IP_ADDRESS_INVALID" });
  });

  it("treats an absent list (Telegram's default) as different and sets the explicit one", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(info({}))
      .mockResolvedValueOnce(answer({ ok: true, result: true }))
      .mockResolvedValueOnce(info({ allowed_updates: [...TELEGRAM_ALLOWED_UPDATES] }));

    await expect(check(fetchMock)).resolves.toBe("updated");
    expect(setWebhookBody(fetchMock)).not.toHaveProperty("max_connections");
    expect(setWebhookBody(fetchMock)).not.toHaveProperty("ip_address");
  });

  it.each([
    ["no_webhook", { url: "" }],
    ["foreign_url", { url: "https://other.example.com/eve/v1/telegram" }],
    ["foreign_url", { url: "https://bot.example.com/other/path" }],
    ["foreign_url", { url: "http://bot.example.com/eve/v1/telegram" }],
    ["custom_certificate", { has_custom_certificate: true }],
  ])("leaves a webhook that is not exactly its own alone (%s)", async (outcome, result) => {
    const fetchMock = vi.fn().mockResolvedValue(info({ allowed_updates: ["message"], ...result }));

    await expect(check(fetchMock)).resolves.toBe(outcome);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("changes nothing and asks Telegram nothing without a valid PUBLIC_BASE_URL", async () => {
    for (const publicBaseUrl of [undefined, "", "http://bot.example.com"]) {
      const fetchMock = vi.fn();
      await expect(check(fetchMock, { publicBaseUrl })).resolves.toBe("expected_url_unknown");
      expect(fetchMock).not.toHaveBeenCalled();
    }
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
    await expect(ensureTelegramWebhookSubscription({ botToken: "123:abc", fetch: fetchMock, publicBaseUrl: BASE, secretToken: "" }))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_CONFIG_MISSING" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
