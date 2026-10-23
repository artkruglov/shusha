/**
 * The durable ingress update id of the message that starts a turn.
 *
 * Exports:
 * - `withTelegramUpdateMarker`: stamps the update id into `message.raw` before Eve dispatch.
 * - `readTelegramUpdateMarker`: the stamped id, or null for a message that came another way.
 *
 * The queue of messages that arrive while the turn works is keyed by this id: the running turn
 * shows later updates of the same chat queue (`turn-interjection/`), and the ordinary turn of such
 * a message later learns that it was already shown. Like the series and pending markers, the id
 * rides in `raw` because Eve's Telegram message has no other application-owned field.
 */
import type { TelegramUpdate } from "eve/channels/telegram";

export const TELEGRAM_UPDATE_MARKER_KEY = "osinara_update_id";

export function withTelegramUpdateMarker(
  update: TelegramUpdate & { kind: "message" },
  updateId: string,
): TelegramUpdate {
  const raw = { ...update.message.raw, [TELEGRAM_UPDATE_MARKER_KEY]: updateId };
  return { ...update, message: { ...update.message, raw } };
}

export function readTelegramUpdateMarker(raw: Record<string, unknown>): string | null {
  const value = raw[TELEGRAM_UPDATE_MARKER_KEY];
  return typeof value === "string" && /^\d+$/u.test(value) ? value : null;
}
