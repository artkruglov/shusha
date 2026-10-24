/**
 * What a send the bot starts itself reads first, and what a person's message clears.
 *
 * Exports:
 * - `TelegramProactiveDeliveryKind`: the kind of bot-started send, logged with a skip.
 * - `unreachableTelegramRecipient`: the reason a proactive send must skip this chat, or null.
 * - `claimIfReachable`: takes a dispatcher's claim only for a reachable chat, so a skip marks nothing sent.
 * - `isTelegramBotItself`: whether a Telegram user object is this bot.
 * - `noteInboundTelegramMessage`: records a message as proof that its chat reaches the bot.
 *
 * Key constructs:
 * - Only sends the bot starts itself (overviews, reminders, digests, scheduled runs, alerts) ask
 *   here. An answer to a person's own message or button never does: whoever writes is reachable.
 * - A skip is logged with the chat id, the kind and the reason only, never the text it would have sent,
 *   and at most once an hour per chat and kind: a dispatcher that keeps its work for the chat's return
 *   asks again on every tick.
 * - A skip must not consume the work. A dispatcher either does not take its claim (`claimIfReachable`, or
 *   a claim query that leaves unreachable chats out) or gives the claim back: when the chat is reachable
 *   again, the overview, alert, reminder or scheduled run still goes.
 * - Telegram delivers the service message about the bot's own removal (`left_chat_member` is the bot)
 *   to the removed bot, possibly after the `my_chat_member` that removed it. That message proves the
 *   opposite of reachability and never counts as proof.
 * - Recording never fails the webhook: the update is still acknowledged and stored, and the next
 *   message or the next `my_chat_member` records the proof again.
 */
import type { TelegramRecipientUnreachableReason } from "./recipient-failure.js";
import {
  type TelegramReachabilityRepository,
  telegramReachabilityRepository,
} from "./reachability-repository.js";

export type TelegramProactiveDeliveryKind =
  | "agent_schedule"
  | "errand"
  | "ingress_stall_alert"
  | "initiative"
  | "member_joined_notice"
  | "onboarding_quest"
  | "proactive_message"
  | "relay"
  | "reminder"
  | "software_update"
  | "waitlist_notice";

export interface TelegramBotSelf {
  /** The bot's user id: the part of its token before the colon. */
  readonly id: string | null;
  readonly username: string | null;
}

const SKIP_LOG_INTERVAL_MS = 60 * 60 * 1_000;
const skipLoggedAt = new Map<string, number>();

export async function unreachableTelegramRecipient(
  chatId: string,
  kind: TelegramProactiveDeliveryKind,
  repository: Pick<TelegramReachabilityRepository, "unreachableReason"> = telegramReachabilityRepository,
  now: () => number = Date.now,
): Promise<TelegramRecipientUnreachableReason | null> {
  const reason = await repository.unreachableReason(chatId);
  const key = `${kind}:${chatId}`;
  if (reason === null) {
    skipLoggedAt.delete(key);
    return null;
  }
  const at = now();
  const last = skipLoggedAt.get(key);
  if (last === undefined || at - last >= SKIP_LOG_INTERVAL_MS) {
    skipLoggedAt.set(key, at);
    console.warn(JSON.stringify({ chatId, code: "AGENT_TELEGRAM_PROACTIVE_DELIVERY_SKIPPED", kind, reason }));
  }
  return reason;
}

export async function claimIfReachable<T>(
  chatId: string,
  kind: TelegramProactiveDeliveryKind,
  claim: () => Promise<T | null>,
): Promise<T | null> {
  return await unreachableTelegramRecipient(chatId, kind) === null ? await claim() : null;
}

function configuredBotSelf(): TelegramBotSelf {
  const id = /^([1-9][0-9]*):/u.exec(process.env.TELEGRAM_BOT_TOKEN ?? "")?.[1] ?? null;
  const username = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/u, "") || null;
  return { id, username };
}

export function isTelegramBotItself(user: unknown, self: TelegramBotSelf = configuredBotSelf()): boolean {
  if (user === null || typeof user !== "object") return false;
  const candidate = user as { id?: unknown; is_bot?: unknown; username?: unknown };
  if (candidate.is_bot !== true) return false;
  if (self.id !== null && (typeof candidate.id === "number" || typeof candidate.id === "string")) {
    return String(candidate.id) === self.id;
  }
  return self.username !== null && typeof candidate.username === "string" &&
    candidate.username.toLowerCase() === self.username.toLowerCase();
}

export async function noteInboundTelegramMessage(
  input: { readonly chatId: string; readonly message: Record<string, unknown>; readonly updateId: string },
  dependencies: {
    readonly now?: () => Date;
    readonly repository?: Pick<TelegramReachabilityRepository, "recordInboundMessage">;
    readonly self?: TelegramBotSelf;
  } = {},
): Promise<void> {
  if (isTelegramBotItself(input.message.left_chat_member, dependencies.self)) return;
  const repository = dependencies.repository ?? telegramReachabilityRepository;
  const receivedAt = (dependencies.now ?? (() => new Date()))();
  try {
    // A message without a date is still a message from the chat; it is ordered as the present.
    const date = input.message.date;
    const sentAt = typeof date === "number" && Number.isSafeInteger(date) && date > 0 ? new Date(date * 1_000) : receivedAt;
    const recorded = await repository.recordInboundMessage({ chatId: input.chatId, receivedAt, sentAt, updateId: input.updateId });
    if (recorded?.cleared === true) {
      console.info(JSON.stringify({ chatId: input.chatId, code: "AGENT_TELEGRAM_RECIPIENT_REACHABLE", source: "inbound_message" }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      chatId: input.chatId,
      code: "AGENT_TELEGRAM_REACHABILITY_CLEAR_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
  }
}
