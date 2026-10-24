/**
 * Telegram's `my_chat_member` update: the bot's own status in a chat has changed.
 *
 * Exports:
 * - `parseMyChatMemberUpdate`: the reachability change a verified update carries, or null.
 * - `createMyChatMemberHook` / `handleMyChatMemberUpdate`: the verified-update hook that applies it.
 *
 * Key constructs:
 * - Eve 0.40.0 parses only messages and button presses and acknowledged this update in silence; the
 *   local patch hands it to `onMyChatMember` after the webhook secret is verified.
 * - In a private chat Telegram sends it only when the person blocks the bot (`kicked`) or unblocks it
 *   (`member`). In a group the bot is removed (`left`, `kicked`), restricted out of the chat
 *   (`restricted` with `is_member` false) or back (`member`, `administrator`, `creator`, a restricted
 *   member). Statuses per Bot API 10.3, `ChatMember`. The update changes the mark at once, without
 *   waiting for a proactive send to fail.
 * - The mark is written before Telegram gets 200, so a failed write is retried by Telegram itself;
 *   repeated or reordered deliveries are ordered by the update's date and id in the repository.
 * - Nothing of the update reaches Eve or the model: it carries no message.
 */
import type { TelegramGuestUpdateContext } from "eve/channels/telegram";

import type { TelegramRecipientUnreachableReason } from "./recipient-failure.js";
import {
  type TelegramMembershipChange,
  type TelegramReachabilityRepository,
  telegramReachabilityRepository,
} from "./reachability-repository.js";

export interface MyChatMemberUpdate extends Omit<TelegramMembershipChange, "receivedAt"> {
  readonly chatType: "channel" | "group" | "private" | "supergroup";
  readonly status: string;
}

const CHAT_TYPES = new Set(["channel", "group", "private", "supergroup"]);
const PRESENT_STATUSES = new Set(["administrator", "creator", "member"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Null reason means the bot is reachable there; undefined means the status says nothing about it. */
function reachability(
  chatType: MyChatMemberUpdate["chatType"],
  member: Record<string, unknown>,
): TelegramRecipientUnreachableReason | null | undefined {
  const status = member.status;
  if (chatType === "private") {
    if (status === "kicked") return "blocked";
    if (status === "member") return null;
    return undefined;
  }
  if (status === "kicked") return "kicked";
  if (status === "left") return "not_member";
  if (typeof status === "string" && PRESENT_STATUSES.has(status)) return null;
  if (status === "restricted") return member.is_member === true ? null : "not_member";
  return undefined;
}

export function parseMyChatMemberUpdate(raw: unknown): MyChatMemberUpdate | null {
  const update = record(raw);
  const change = record(update?.my_chat_member);
  const chat = record(change?.chat);
  const member = record(change?.new_chat_member);
  const updateId = update?.update_id;
  const date = change?.date;
  if (!chat || !member || !safeInteger(chat.id) || chat.id === 0 || typeof chat.type !== "string" ||
      !CHAT_TYPES.has(chat.type) || !safeInteger(date) || date <= 0 ||
      !safeInteger(updateId) || updateId < 0 || typeof member.status !== "string") return null;
  const chatType = chat.type as MyChatMemberUpdate["chatType"];
  const reason = reachability(chatType, member);
  if (reason === undefined) return null;
  return {
    changedAt: new Date(date * 1_000),
    chatId: String(chat.id),
    chatType,
    reason,
    status: member.status,
    updateId: String(updateId),
  };
}

export function createMyChatMemberHook(
  repository: Pick<TelegramReachabilityRepository, "applyMembershipChange">,
  now: () => Date = () => new Date(),
) {
  return async function handleMyChatMemberUpdate(context: Pick<TelegramGuestUpdateContext, "raw">): Promise<Response> {
    const update = parseMyChatMemberUpdate(context.raw);
    if (update === null) {
      // A shape this hook cannot read must not be redelivered forever; nothing of it is logged.
      console.warn(JSON.stringify({ code: "AGENT_TELEGRAM_MEMBERSHIP_UPDATE_IGNORED" }));
      return new Response("ok");
    }
    // The receipt time is the proof's time for a later stale 403: the same clock as a send's start.
    const applied = await repository.applyMembershipChange({ ...update, receivedAt: now() });
    console.info(JSON.stringify({
      applied,
      chatId: update.chatId,
      chatType: update.chatType,
      code: update.reason === null ? "AGENT_TELEGRAM_RECIPIENT_REACHABLE" : "AGENT_TELEGRAM_RECIPIENT_UNREACHABLE",
      reason: update.reason,
      source: "membership_update",
      status: update.status,
      updateId: update.updateId,
    }));
    return new Response("ok");
  };
}

export const handleMyChatMemberUpdate = createMyChatMemberHook(telegramReachabilityRepository);
