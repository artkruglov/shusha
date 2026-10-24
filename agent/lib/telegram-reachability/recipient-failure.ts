/**
 * Telegram's definite answers that a chat can no longer receive the bot's messages.
 *
 * Exports:
 * - `TELEGRAM_RECIPIENT_UNREACHABLE_CODE`: the stable code of every such answer.
 * - `TelegramRecipientUnreachableReason`: why the chat is unreachable.
 * - `classifyTelegramRecipientFailure`: the reason behind a failed Bot API answer, or null.
 * - `telegramProviderDescription`: Telegram's own description of a failure, bounded for logs.
 *
 * Key construct:
 * - Only these answers are about the recipient rather than the request: a blocked bot, a deleted
 *   account, a bot removed from or absent in a group, a chat Telegram does not know and a person who
 *   never started the bot. Repeating such a send only repeats the failure until the person writes
 *   again or the bot is added back. Every other 400/403 (missing rights, a group upgraded to a
 *   supergroup, a bad parameter) stays an ordinary failure: it says nothing about the chat itself.
 * - The descriptions are matched whole, so a longer description that merely contains one of them is
 *   not mistaken for it.
 */
export const TELEGRAM_RECIPIENT_UNREACHABLE_CODE = "AGENT_TELEGRAM_RECIPIENT_UNREACHABLE";

export const TELEGRAM_RECIPIENT_UNREACHABLE_REASONS = [
  "blocked",
  "deactivated",
  "kicked",
  "not_found",
  "not_member",
  "not_started",
] as const;

export type TelegramRecipientUnreachableReason = typeof TELEGRAM_RECIPIENT_UNREACHABLE_REASONS[number];

const DESCRIPTION_LOG_MAX_LENGTH = 200;

const RECIPIENT_FAILURES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly reason: TelegramRecipientUnreachableReason;
  readonly status: number;
}> = [
  { pattern: /^Forbidden: bot was blocked by the user$/u, reason: "blocked", status: 403 },
  { pattern: /^Forbidden: user is deactivated$/u, reason: "deactivated", status: 403 },
  { pattern: /^Forbidden: bot was kicked from the (?:group|supergroup|channel) chat$/u, reason: "kicked", status: 403 },
  { pattern: /^Forbidden: bot is not a member of the (?:group|supergroup|channel) chat$/u, reason: "not_member", status: 403 },
  { pattern: /^Forbidden: bot can't initiate conversation with a user$/u, reason: "not_started", status: 403 },
  { pattern: /^Bad Request: chat not found$/u, reason: "not_found", status: 400 },
];

function rawDescription(body: unknown): string | null {
  const description = (body as { description?: unknown } | null)?.description;
  return typeof description === "string" ? description : null;
}

/** Telegram's description of a failed call: not a person's text, but still bounded in a log line. */
export function telegramProviderDescription(body: unknown): string | null {
  const description = rawDescription(body);
  return description === null ? null : description.slice(0, DESCRIPTION_LOG_MAX_LENGTH);
}

export function classifyTelegramRecipientFailure(
  status: number,
  body: unknown,
): TelegramRecipientUnreachableReason | null {
  const errorCode = (body as { error_code?: unknown } | null)?.error_code;
  const code = typeof errorCode === "number" ? errorCode : status;
  const description = rawDescription(body)?.trim();
  if (description === undefined) return null;
  return RECIPIENT_FAILURES.find((failure) =>
    failure.status === code && failure.pattern.test(description))?.reason ?? null;
}
