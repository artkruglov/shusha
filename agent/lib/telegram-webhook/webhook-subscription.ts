/**
 * Brings the webhook of a running installation up to what the application handles.
 *
 * Exports:
 * - `TelegramWebhookSubscriptionOutcome`: what the check did.
 * - `ensureTelegramWebhookSubscription`: compares the webhook Telegram reports with the expected one and,
 *   when the update list or the configured IP differ, repeats `setWebhook` for the expected URL.
 *
 * Key constructs:
 * - `setWebhook` used to run only in the installer, so an installation set up before a new update type
 *   never received it: `chat_join_request` and `my_chat_member` reached no running bot until its owner
 *   ran the installer again. The agent holds the same token and webhook secret, so it now fixes the
 *   list itself.
 * - The webhook is the agent's own only when Telegram reports exactly `PUBLIC_BASE_URL` plus the route
 *   (`telegramWebhookUrl`, the installer's builder too); the secret never goes to another host, even one
 *   with the same path. Without a valid `PUBLIC_BASE_URL` nothing is changed (`expected_url_unknown`).
 *   No URL (no webhook at all) and a custom certificate the agent does not hold and a new `setWebhook`
 *   would drop are left alone as well.
 * - Nothing else changes: the secret is the one the agent verifies every update against, `max_connections`
 *   is carried over, pending updates are kept. The IP is fixed only by `TELEGRAM_WEBHOOK_IP_ADDRESS`: set,
 *   it is sent and a webhook delivering elsewhere is registered again; unset, the field is never sent
 *   (`webhook-registration.ts`). `WebhookInfo.ip_address` is the IP in use (Bot API 10.3) and cannot tell
 *   a fixed IP from a resolved one, so it never decides anything here.
 */
import { callTelegramApi } from "eve/channels/telegram";

import { AppError } from "../app-error.js";
import {
  parseTelegramWebhookIpAddress,
  TELEGRAM_ALLOWED_UPDATES,
  telegramWebhookRegistration,
  telegramWebhookUrl,
} from "./webhook-registration.js";
import {
  boundedTelegramFetch,
  readTelegramWebhookInfo,
  type TelegramWebhookCallOptions,
} from "./webhook-info.js";

export type TelegramWebhookSubscriptionOutcome =
  | "custom_certificate"
  | "expected_url_unknown"
  | "foreign_url"
  | "no_webhook"
  | "unchanged"
  | "updated";

const SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;

function sameUpdates(current: readonly string[] | null): boolean {
  if (current === null || current.length !== TELEGRAM_ALLOWED_UPDATES.length) return false;
  const wanted = new Set<string>(TELEGRAM_ALLOWED_UPDATES);
  return current.every((type) => wanted.has(type)) && new Set(current).size === wanted.size;
}

function normalizedUrl(value: string): string | null {
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

function sameIp(current: string | null, wanted: string | null): boolean {
  return wanted === null || current?.toLowerCase() === wanted.toLowerCase();
}

export async function ensureTelegramWebhookSubscription(
  options: TelegramWebhookCallOptions & {
    /** `TELEGRAM_WEBHOOK_IP_ADDRESS`: the only way the webhook is fixed to an IP. */
    readonly ipAddress?: string;
    /** `PUBLIC_BASE_URL`: the origin the expected webhook URL is built from. */
    readonly publicBaseUrl: string | undefined;
    readonly secretToken: string;
  },
): Promise<TelegramWebhookSubscriptionOutcome> {
  if (!SECRET_PATTERN.test(options.secretToken)) {
    throw new AppError("AGENT_TELEGRAM_CONFIG_MISSING", "Не задан корректный секрет вебхука Telegram");
  }
  let ipAddress: string | null;
  try {
    ipAddress = parseTelegramWebhookIpAddress(options.ipAddress);
  } catch {
    throw new AppError("AGENT_TELEGRAM_WEBHOOK_IP_ADDRESS_INVALID", "TELEGRAM_WEBHOOK_IP_ADDRESS должен быть адресом IPv4 или IPv6");
  }
  const expectedUrl = telegramWebhookUrl(options.publicBaseUrl);
  if (expectedUrl === null) return "expected_url_unknown";
  const info = await readTelegramWebhookInfo(options);
  if (info.url === "") return "no_webhook";
  if (normalizedUrl(info.url) !== expectedUrl) return "foreign_url";
  if (info.hasCustomCertificate) return "custom_certificate";
  if (sameUpdates(info.allowedUpdates) && sameIp(info.ipAddress, ipAddress)) return "unchanged";

  let response;
  try {
    response = await callTelegramApi({
      body: telegramWebhookRegistration({
        ipAddress, maxConnections: info.maxConnections, secretToken: options.secretToken, url: expectedUrl,
      }),
      botToken: options.botToken,
      fetch: boundedTelegramFetch(options),
      method: "setWebhook",
    });
  } catch {
    throw new AppError("AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_FAILED", "Не удалось связаться с Telegram для обновления вебхука");
  }
  if (!response.ok || (response.body as { result?: unknown } | null)?.result !== true) {
    throw new AppError(
      "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_FAILED",
      `Telegram не принял обновлённую регистрацию вебхука (HTTP ${response.status})`,
    );
  }
  // Telegram must now report the same webhook with the new list and IP, or the change did not take.
  const confirmed = await readTelegramWebhookInfo(options);
  if (normalizedUrl(confirmed.url) !== expectedUrl || !sameUpdates(confirmed.allowedUpdates) ||
      !sameIp(confirmed.ipAddress, ipAddress)) {
    throw new AppError(
      "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_UNCONFIRMED",
      "Telegram не подтвердил обновлённую регистрацию вебхука",
    );
  }
  return "updated";
}
