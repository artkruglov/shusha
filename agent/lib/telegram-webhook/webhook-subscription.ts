/**
 * Brings the update list of a running installation up to what the application handles.
 *
 * Exports:
 * - `TelegramWebhookSubscriptionOutcome`: what the check did.
 * - `ensureTelegramWebhookSubscription`: compares `allowed_updates` with `TELEGRAM_ALLOWED_UPDATES`
 *   and, when they differ, repeats `setWebhook` for the very URL Telegram already has.
 *
 * Key constructs:
 * - `setWebhook` used to run only in the installer, so an installation set up before a new update type
 *   never received it: `chat_join_request` and `my_chat_member` reached no running bot until its owner
 *   ran the installer again. The agent holds the same token and webhook secret, so it now fixes the
 *   list itself.
 * - Nothing but the list changes. The URL is the one Telegram reports, so a relay in front of the agent
 *   stays in place; the secret is the one the agent verifies every update against; `max_connections` is
 *   carried over; pending updates are kept. A webhook the agent cannot have set is left alone: no URL
 *   (no webhook at all), a foreign path, or a custom certificate the agent does not hold and a new
 *   `setWebhook` would drop.
 * - `ip_address` (Bot API 10.3): a `setWebhook` without it makes Telegram resolve the host through DNS
 *   again, dropping an IP fixed by hand; `WebhookInfo.ip_address` is only the IP in use and does not say
 *   whether it was fixed. The installer never fixes one. Passing the reported IP back would fix a
 *   DNS-chosen IP for good, so a later move of the host would silently lose every update. Instead the
 *   host is resolved here: when one of its addresses is the IP in use, a `setWebhook` without the field
 *   keeps delivery where it is now; when none is, or DNS does not answer, the IP may be fixed by hand and
 *   the webhook is left for the owner to re-register.
 */
import { lookup } from "node:dns/promises";

import { callTelegramApi } from "eve/channels/telegram";

import { AppError } from "../app-error.js";
import { TELEGRAM_ALLOWED_UPDATES, TELEGRAM_WEBHOOK_PATH } from "./allowed-updates.js";
import {
  boundedTelegramFetch,
  readTelegramWebhookInfo,
  type TelegramWebhookCallOptions,
  type TelegramWebhookInfo,
} from "./webhook-info.js";

export type TelegramWebhookSubscriptionOutcome =
  | "custom_certificate"
  | "foreign_url"
  | "ip_address_unverified"
  | "no_webhook"
  | "pinned_ip_address"
  | "unchanged"
  | "updated";

/** Every address the host name resolves to; the default asks the system resolver. */
export type TelegramWebhookHostResolver = (hostname: string) => Promise<readonly string[]>;

const resolveHost: TelegramWebhookHostResolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

const SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;

function sameUpdates(current: readonly string[] | null): boolean {
  if (current === null || current.length !== TELEGRAM_ALLOWED_UPDATES.length) return false;
  const wanted = new Set<string>(TELEGRAM_ALLOWED_UPDATES);
  return current.every((type) => wanted.has(type)) && new Set(current).size === wanted.size;
}

function ownWebhook(info: TelegramWebhookInfo): TelegramWebhookSubscriptionOutcome | null {
  if (info.url === "") return "no_webhook";
  let url: URL;
  try {
    url = new URL(info.url);
  } catch {
    return "foreign_url";
  }
  if (url.protocol !== "https:" || url.pathname !== TELEGRAM_WEBHOOK_PATH || url.search !== "") return "foreign_url";
  if (info.hasCustomCertificate) return "custom_certificate";
  return null;
}

/** Null when the IP in use is one the host resolves to, so a DNS-resolved webhook delivers to it as well. */
async function pinnedIpAddressOutcome(
  info: TelegramWebhookInfo,
  resolver: TelegramWebhookHostResolver,
): Promise<TelegramWebhookSubscriptionOutcome | null> {
  if (info.ipAddress === null) return null;
  let addresses: readonly string[];
  try {
    addresses = await resolver(new URL(info.url).hostname);
  } catch {
    return "ip_address_unverified";
  }
  const inUse = info.ipAddress.toLowerCase();
  return addresses.some((address) => address.toLowerCase() === inUse) ? null : "pinned_ip_address";
}

export async function ensureTelegramWebhookSubscription(
  options: TelegramWebhookCallOptions & {
    readonly resolveHost?: TelegramWebhookHostResolver;
    readonly secretToken: string;
  },
): Promise<TelegramWebhookSubscriptionOutcome> {
  if (!SECRET_PATTERN.test(options.secretToken)) {
    throw new AppError("AGENT_TELEGRAM_CONFIG_MISSING", "Не задан корректный секрет вебхука Telegram");
  }
  const info = await readTelegramWebhookInfo(options);
  const foreign = ownWebhook(info);
  if (foreign !== null) return foreign;
  if (sameUpdates(info.allowedUpdates)) return "unchanged";
  const pinned = await pinnedIpAddressOutcome(info, options.resolveHost ?? resolveHost);
  if (pinned !== null) return pinned;

  let response;
  try {
    response = await callTelegramApi({
      body: {
        allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
        ...(info.maxConnections === null ? {} : { max_connections: info.maxConnections }),
        secret_token: options.secretToken,
        url: info.url,
      },
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
      `Telegram не принял обновлённый список апдейтов (HTTP ${response.status})`,
    );
  }
  // Telegram must now report the same webhook with the new list, or the change did not take.
  const confirmed = await readTelegramWebhookInfo(options);
  if (confirmed.url !== info.url || !sameUpdates(confirmed.allowedUpdates)) {
    throw new AppError(
      "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_UNCONFIRMED",
      "Telegram не подтвердил обновлённый список апдейтов вебхука",
    );
  }
  return "updated";
}
