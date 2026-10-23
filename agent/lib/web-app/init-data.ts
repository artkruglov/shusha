/**
 * Who opened the Mini App: the Telegram user id from signed `initData`, and nothing else.
 *
 * Exports:
 * - `WEB_APP_INIT_DATA_MAX_AGE_SECONDS`: how long a signature is accepted.
 * - `verifiedWebAppUser`: the user id after the signature and age checks, or `AGENT_WEB_APP_UNAUTHORIZED`.
 *
 * Telegram signs `initData` with a key derived from the bot token
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app): the secret is
 * HMAC-SHA256 of the token keyed by "WebAppData", and the hash is HMAC-SHA256 of every other field,
 * sorted and joined by newlines. Only the bot and Telegram know the token, so a matching hash means
 * Telegram gave this data to this person. The page could send any JSON; the identity comes only from
 * here. The raw `initData` is a bearer credential for an hour and is never logged.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { AppError } from "../app-error.js";

export const WEB_APP_INIT_DATA_MAX_AGE_SECONDS = 60 * 60;
const INIT_DATA_MAX_LENGTH = 4096;
const UNAUTHORIZED = "Открой доску заново из Telegram";

function refuse(): never {
  throw new AppError("AGENT_WEB_APP_UNAUTHORIZED", UNAUTHORIZED);
}

export function verifiedWebAppUser(initData: string, botToken: string, now: Date): { telegramUserId: string } {
  if (initData.length === 0 || initData.length > INIT_DATA_MAX_LENGTH) refuse();
  const fields = new URLSearchParams(initData);
  const hash = fields.get("hash");
  if (hash === null || !/^[0-9a-f]{64}$/u.test(hash)) refuse();
  const keys = [...fields.keys()];
  // A repeated field would be signed one way and read another.
  if (new Set(keys).size !== keys.length) refuse();
  const checkString = keys.filter((key) => key !== "hash").sort()
    .map((key) => `${key}=${fields.get(key)}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) refuse();

  const authDate = Number(fields.get("auth_date"));
  const age = now.getTime() / 1000 - authDate;
  if (!Number.isSafeInteger(authDate) || age > WEB_APP_INIT_DATA_MAX_AGE_SECONDS || age < -60) refuse();

  let user: unknown;
  try {
    user = JSON.parse(fields.get("user") ?? "null");
  } catch {
    refuse();
  }
  const id = (user as { id?: unknown } | null)?.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) refuse();
  if ((user as { is_bot?: unknown }).is_bot === true) refuse();
  return { telegramUserId: String(id) };
}
