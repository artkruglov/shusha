/**
 * The step status of a turn (`telegram-step-status.ts`) wired to the Telegram channel events.
 *
 * Exports:
 * - `telegramStepStatusTransport`: silent send, edit and delete through the channel's Bot API handle.
 * - `beginTelegramTurnSteps`, `recordTelegramTurnSteps`, `allowTelegramTurnSteps`,
 *   `closeTelegramTurnSteps`: the channel events' entry points.
 *
 * Key construct:
 * - Who may see a status is the same rule as «печатает…» (`telegram-typing-heartbeat.ts`): a person's
 *   own private-chat turn at once, a group turn only after a progress notice has gone out (it might
 *   otherwise end in deliberate silence), scheduled and memory-review turns never.
 * - The status carries a search query or a domain from the call, so like a progress notice it is
 *   sent only after the space delivery check of that turn passed (`canDeliver`).
 */
import type { SessionContext } from "eve/context";
import type { TelegramHandle } from "eve/channels/telegram";

import { isScheduledSession } from "./agent-schedules/scheduled-session.js";
import { isMemoryReviewSession } from "./memory-review/memory-review-session.js";
import { progressNoticeKey } from "./telegram-progress-deferral.js";
import {
  describeTelegramStep,
  telegramStepStatus,
  type TelegramStepAction,
  type TelegramStepStatusTransport,
} from "./telegram-step-status.js";
import { startsTypingHeartbeat } from "./telegram-typing-heartbeat.js";

/** Telegram allows a group twenty sends a minute, edits included; a private chat one a second. */
const PRIVATE_EDIT_GAP_MS = 3_000;
const GROUP_EDIT_GAP_MS = 6_000;

interface TurnContext {
  session: { auth: SessionContext["session"]["auth"]; id: string; turn: { id: string } };
}

type StatusTelegram = Pick<TelegramHandle, "chatId" | "messageThreadId" | "request">;

const allowedGroupTurns = new Set<string>();

function messageId(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const result = (body as { result?: { message_id?: unknown } }).result;
  return typeof result?.message_id === "number" ? result.message_id : null;
}

export function telegramStepStatusTransport(telegram: StatusTelegram): TelegramStepStatusTransport {
  const target = {
    chat_id: telegram.chatId,
    ...(telegram.messageThreadId === undefined ? {} : { message_thread_id: telegram.messageThreadId }),
  };
  return {
    async send(text) {
      const response = await telegram.request("sendMessage", {
        ...target,
        disable_notification: true,
        link_preview_options: { is_disabled: true },
        text,
      });
      return response.ok ? messageId(response.body) : null;
    },
    async edit(id, text) {
      // «message is not modified» and a message the person already deleted are both harmless here.
      await telegram.request("editMessageText", {
        chat_id: telegram.chatId,
        link_preview_options: { is_disabled: true },
        message_id: id,
        text,
      });
    },
    async remove(id) {
      await telegram.request("deleteMessage", { chat_id: telegram.chatId, message_id: id });
    },
  };
}

function key(ctx: TurnContext): string {
  return progressNoticeKey(ctx.session.id, ctx.session.turn.id);
}

function isPrivateTurn(ctx: TurnContext): boolean {
  return startsTypingHeartbeat({
    chatType: ctx.session.auth.current?.attributes.telegramChatType,
    memoryReview: isMemoryReviewSession(ctx),
    scheduled: isScheduledSession(ctx),
  });
}

export function beginTelegramTurnSteps(ctx: TurnContext): void {
  if (isPrivateTurn(ctx)) telegramStepStatus.begin(key(ctx));
}

/** A progress notice went out in a group turn: from here on its steps may be shown too. */
export function allowTelegramTurnSteps(ctx: TurnContext): void {
  if (isScheduledSession(ctx)) return;
  allowedGroupTurns.add(key(ctx));
  telegramStepStatus.begin(key(ctx));
}

export async function recordTelegramTurnSteps(
  channel: { telegram: StatusTelegram },
  ctx: TurnContext,
  actions: readonly TelegramStepAction[],
  canDeliver: () => Promise<boolean>,
): Promise<void> {
  const turnKey = key(ctx);
  const privateTurn = isPrivateTurn(ctx);
  if (!privateTurn && !allowedGroupTurns.has(turnKey)) return;
  // Quick bookkeeping steps show nothing, so they need no delivery check either.
  if (!actions.some((action) => describeTelegramStep(action) !== null)) return;
  if (!await canDeliver()) return;
  telegramStepStatus.record(
    turnKey,
    actions,
    telegramStepStatusTransport(channel.telegram),
    privateTurn ? PRIVATE_EDIT_GAP_MS : GROUP_EDIT_GAP_MS,
  );
}

/** The answer, a confirmation prompt, a failure or a cancellation: the status goes away. */
export async function closeTelegramTurnSteps(ctx: { session: { id: string; turn: { id: string } } }): Promise<void> {
  const turnKey = progressNoticeKey(ctx.session.id, ctx.session.turn.id);
  allowedGroupTurns.delete(turnKey);
  await telegramStepStatus.close(turnKey);
}
