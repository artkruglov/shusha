/**
 * The application's way to the process-wide Telegram send pacer for requests that bypass Eve's channel.
 *
 * Export:
 * - `pacedTelegramMultipartSend`: one multipart Bot API request (photo, document, media group) under the
 *   same per-chat and global limits as every channel call, repeated once after a 429 that named its wait.
 *
 * The pacer lives in scripts/eve-runtime and is installed next to Eve's Telegram `api.js` by the Eve patch;
 * the application image carries no `scripts/` tree, so the installed copy registers its function on
 * `globalThis`. Importing Eve's Telegram entry loads that copy first. A missing registration means the patch
 * is absent, which fails closed instead of sending unpaced.
 */
import "eve/channels/telegram";

import { AppError } from "./app-error.js";

type PacedSend = (
  method: string,
  body: unknown,
  send: () => Promise<Response>,
  parse: (response: Response) => Promise<unknown>,
) => Promise<{ body: unknown; response: Response }>;

const PACED_SEND_KEY = Symbol.for("osinara.pacedTelegramSend");

function pacedSend(): PacedSend {
  const registered = (globalThis as { [key: symbol]: unknown })[PACED_SEND_KEY];
  if (typeof registered !== "function") {
    throw new AppError("AGENT_TELEGRAM_PACER_MISSING", "Ограничитель отправки в Telegram не установлен");
  }
  return registered as PacedSend;
}

/** Sends one multipart request to `chatId` under the pacer; the returned response stays readable. */
export async function pacedTelegramMultipartSend(
  method: string,
  chatId: number | string,
  send: () => Promise<Response>,
): Promise<Response> {
  const { response } = await pacedSend()(
    method,
    { chat_id: chatId },
    send,
    async (candidate) => await candidate.clone().json().catch(() => null),
  );
  return response;
}
