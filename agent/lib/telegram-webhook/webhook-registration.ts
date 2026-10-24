/**
 * What the bot's webhook must look like, shared by the installer and the running agent.
 *
 * Exports:
 * - `TELEGRAM_WEBHOOK_PATH`: the path of the verified webhook route.
 * - `TELEGRAM_ALLOWED_UPDATES`: every update type the application handles.
 * - `telegramWebhookUrl`: the webhook URL of an installation from its `PUBLIC_BASE_URL`, or null.
 * - `parseTelegramWebhookIpAddress`: the optional `TELEGRAM_WEBHOOK_IP_ADDRESS`, validated, or null.
 * - `telegramWebhookRegistration`: the `setWebhook` body both callers send.
 *
 * Key constructs:
 * - Telegram delivers only the types named in `allowed_updates`, and a `setWebhook` without the field keeps
 *   the previous list (Bot API 10.3, `setWebhook`). A type the application handles but the list misses is
 *   lost in silence, so the list lives in one place: `my_chat_member` (the bot blocked or unblocked in a
 *   private chat, removed from or added to a group) joined it on 24 October 2026.
 * - The URL is the installation's own public origin plus the route, never whatever Telegram reports: the
 *   webhook secret goes only to that exact address.
 * - `ip_address` makes Telegram send to a fixed IP instead of resolving the host. A webhook is fixed to an
 *   IP only through `TELEGRAM_WEBHOOK_IP_ADDRESS`; without it the field is never sent, and an IP fixed by
 *   hand outside that setting is not supported: the next registration returns the webhook to DNS.
 */
import { isIP } from "node:net";

export const TELEGRAM_WEBHOOK_PATH = "/eve/v1/telegram";

export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "guest_message",
  "chat_join_request",
  "my_chat_member",
] as const;

/** `PUBLIC_BASE_URL` must be a bare https origin; a trailing slash is the same origin. */
export function telegramWebhookUrl(publicBaseUrl: string | undefined): string | null {
  if (!publicBaseUrl) return null;
  let base: URL;
  try {
    base = new URL(publicBaseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" || base.pathname !== "/" || base.search || base.hash || base.username || base.password) {
    return null;
  }
  return new URL(TELEGRAM_WEBHOOK_PATH, base).href;
}

export function parseTelegramWebhookIpAddress(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  if (isIP(trimmed) === 0) {
    throw new Error("AGENT_TELEGRAM_WEBHOOK_IP_ADDRESS_INVALID: TELEGRAM_WEBHOOK_IP_ADDRESS должен быть адресом IPv4 или IPv6");
  }
  return trimmed;
}

export function telegramWebhookRegistration(input: {
  readonly ipAddress: string | null;
  readonly maxConnections?: number | null;
  readonly secretToken: string;
  readonly url: string;
}): { allowed_updates: string[]; ip_address?: string; max_connections?: number; secret_token: string; url: string } {
  return {
    allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
    ...(input.ipAddress === null ? {} : { ip_address: input.ipAddress }),
    ...(input.maxConnections === null || input.maxConnections === undefined ? {} : { max_connections: input.maxConnections }),
    secret_token: input.secretToken,
    url: input.url,
  };
}
