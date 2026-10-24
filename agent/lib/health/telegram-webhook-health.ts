/**
 * Webhook health for the owner digest.
 *
 * Exports:
 * - `TelegramWebhookHealth`: what Telegram reports about update delivery, or that it could not be read.
 * - `readTelegramWebhookHealth`: one `getWebhookInfo`; never throws, because the digest exists to arrive.
 * - `formatTelegramWebhookHealth`: the failure line, or null for a healthy webhook.
 *
 * Key constructs:
 * - A webhook that Telegram cannot reach looks from inside exactly like a quiet day: no update arrives,
 *   so nothing fails. Only Telegram knows that updates are piling up (`pending_update_count`) and why the
 *   last delivery failed (`last_error_date`, `last_error_message`; Bot API 10.3, `WebhookInfo`).
 * - More than 100 pending updates or a delivery error in the last 24 hours is a failure of the day; an
 *   older error is history. An empty URL means no webhook at all: the bot hears nothing.
 * - `last_error_message` is Telegram's text about our endpoint, not a person's, and is cut to 200 characters.
 */
import { AppError } from "../app-error.js";
import { readTelegramWebhookInfo } from "../telegram-webhook/webhook-info.js";

export const TELEGRAM_WEBHOOK_PENDING_ALERT = 100;
export const TELEGRAM_WEBHOOK_ERROR_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1_000;
const ERROR_MESSAGE_MAX_LENGTH = 200;

export type TelegramWebhookHealth =
  | {
    readonly lastErrorAt: Date | null;
    readonly lastErrorMessage: string | null;
    readonly pendingUpdateCount: number;
    readonly status: "read";
    readonly url: string;
  }
  | { readonly status: "unreadable" };

const MOSCOW = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric", hour: "2-digit", minute: "2-digit", month: "long", timeZone: "Europe/Moscow",
});

export async function readTelegramWebhookHealth(input: {
  readonly botToken: string | undefined;
  readonly fetch?: typeof fetch;
}): Promise<TelegramWebhookHealth> {
  if (!input.botToken) return unreadable("AGENT_TELEGRAM_CONFIG_MISSING");
  try {
    const info = await readTelegramWebhookInfo({
      botToken: input.botToken,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    return {
      lastErrorAt: info.lastErrorDate === null ? null : new Date(info.lastErrorDate * 1_000),
      lastErrorMessage: info.lastErrorMessage,
      pendingUpdateCount: info.pendingUpdateCount,
      status: "read",
      url: info.url,
    };
  } catch (error) {
    return unreadable(error instanceof AppError ? error.code : "AGENT_TELEGRAM_WEBHOOK_INFO_UNAVAILABLE");
  }
}

function unreadable(reason: string): TelegramWebhookHealth {
  console.error(JSON.stringify({ code: "AGENT_TELEGRAM_WEBHOOK_HEALTH_UNREADABLE", reason }));
  return { status: "unreadable" };
}

export function formatTelegramWebhookHealth(health: TelegramWebhookHealth | null, now: Date): string | null {
  if (health === null) return null;
  if (health.status === "unreadable") return "Вебхук Telegram: не удалось проверить вебхук.";
  if (health.url === "") return "Вебхук Telegram не установлен: бот не получает сообщений.";
  const freshError = health.lastErrorAt !== null &&
    now.getTime() - health.lastErrorAt.getTime() <= TELEGRAM_WEBHOOK_ERROR_WINDOW_MILLISECONDS;
  if (health.pendingUpdateCount <= TELEGRAM_WEBHOOK_PENDING_ALERT && !freshError) return null;
  const error = freshError && health.lastErrorAt !== null
    ? `, последняя ошибка доставки ${MOSCOW.format(health.lastErrorAt)}` +
      (health.lastErrorMessage === null ? "" : `: ${health.lastErrorMessage.slice(0, ERROR_MESSAGE_MAX_LENGTH)}`)
    : "";
  return `Вебхук Telegram: ожидающих апдейтов ${health.pendingUpdateCount}${error}.`;
}
