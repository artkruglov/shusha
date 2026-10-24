/**
 * Telegram's own view of the bot's webhook (`getWebhookInfo`).
 *
 * Exports:
 * - `TelegramWebhookInfo`: the fields of `WebhookInfo` the application reads (Bot API 10.3).
 * - `readTelegramWebhookInfo`: one bounded call; throws a coded error when the answer is unusable.
 *
 * Key construct:
 * - `url` is empty when no webhook is set; `allowed_updates` is absent when the bot never narrowed
 *   the default list; `last_error_*` are absent until a delivery has failed. Absent stays null here
 *   instead of becoming a guessed default.
 * - `ip_address` is the IP Telegram currently delivers to. It does not say whether that IP was fixed by
 *   `setWebhook` or resolved through DNS.
 */
import { callTelegramApi } from "eve/channels/telegram";
import { z } from "zod";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import { withRequestTimeout } from "../request-signal.js";

export interface TelegramWebhookInfo {
  readonly allowedUpdates: readonly string[] | null;
  readonly hasCustomCertificate: boolean;
  readonly ipAddress: string | null;
  readonly lastErrorDate: number | null;
  readonly lastErrorMessage: string | null;
  readonly maxConnections: number | null;
  readonly pendingUpdateCount: number;
  readonly url: string;
}

const webhookInfoAnswerSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    allowed_updates: z.array(z.string()).optional(),
    has_custom_certificate: z.boolean(),
    ip_address: z.string().min(1).optional(),
    last_error_date: z.number().int().nonnegative().optional(),
    last_error_message: z.string().optional(),
    max_connections: z.number().int().positive().optional(),
    pending_update_count: z.number().int().nonnegative(),
    url: z.string(),
  }),
});

export interface TelegramWebhookCallOptions {
  readonly botToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

export function boundedTelegramFetch(options: TelegramWebhookCallOptions): typeof fetch {
  return withRequestTimeout(options.fetch ?? fetch, options.timeoutMilliseconds ?? TELEGRAM_API_REQUEST_TIMEOUT_MS);
}

export async function readTelegramWebhookInfo(options: TelegramWebhookCallOptions): Promise<TelegramWebhookInfo> {
  let response;
  try {
    response = await callTelegramApi({
      botToken: options.botToken,
      fetch: boundedTelegramFetch(options),
      method: "getWebhookInfo",
    });
  } catch {
    throw new AppError("AGENT_TELEGRAM_WEBHOOK_INFO_UNAVAILABLE", "Не удалось связаться с Telegram для проверки вебхука");
  }
  if (!response.ok) {
    throw new AppError(
      "AGENT_TELEGRAM_WEBHOOK_INFO_UNAVAILABLE",
      `Telegram не ответил на проверку вебхука (HTTP ${response.status})`,
    );
  }
  const answer = webhookInfoAnswerSchema.safeParse(response.body);
  if (!answer.success) {
    throw new AppError("AGENT_TELEGRAM_WEBHOOK_INFO_INVALID", "Telegram вернул некорректные сведения о вебхуке");
  }
  const info = answer.data.result;
  return {
    allowedUpdates: info.allowed_updates ?? null,
    hasCustomCertificate: info.has_custom_certificate,
    ipAddress: info.ip_address ?? null,
    lastErrorDate: info.last_error_date ?? null,
    lastErrorMessage: info.last_error_message ?? null,
    maxConnections: info.max_connections ?? null,
    pendingUpdateCount: info.pending_update_count,
    url: info.url,
  };
}
