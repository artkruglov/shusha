/**
 * «Печатает…» for the whole of a turn, not just its first five seconds.
 *
 * Exports:
 * - `createTelegramTypingHeartbeat`: a per-turn heartbeat with an injected clock, for tests.
 * - `telegramTypingHeartbeat`: the process-wide instance the channel uses.
 * - `startsTypingHeartbeat`: whether a turn may start the indicator on its own.
 * - `keepTelegramTurnTyping` / `stopTelegramTurnTyping`: the channel events' entry points.
 *
 * Key construct:
 * - Eve's default channel events send a typing action on `turn.started` and `actions.requested`; the
 *   application overrides both, so since the first release a two-minute turn showed nothing at all
 *   until its first message (review of 13 October 2026). Telegram shows the action for about five
 *   seconds, so it is repeated while the turn runs.
 * - The heartbeat is process memory, never persisted. A turn that moves to another worker stops
 *   being touched here and the old timer ends after `idleLimitMs`; a turn that stays is stopped by its
 *   own answer, confirmation prompt, failure or cancellation.
 * - Only a person's own message in a private chat starts it. A group turn may end in deliberate
 *   silence, and «печатает…» followed by nothing reads as a bot that changed its mind; there the
 *   indicator starts once a progress notice has gone out. Scheduled and memory-review turns never
 *   start it: nobody is waiting for them.
 */
import type { SessionContext } from "eve/context";

import { isScheduledSession } from "./agent-schedules/scheduled-session.js";
import { isMemoryReviewSession } from "./memory-review/memory-review-session.js";
import { progressNoticeKey } from "./telegram-progress-deferral.js";

const TYPING_INTERVAL_MS = 4_500;
/** Longer than any single tool step that sends no event (a browser task, a research subagent). */
const TYPING_IDLE_LIMIT_MS = 5 * 60_000;

export interface TypingHeartbeatClock {
  clearInterval(handle: ReturnType<typeof setInterval>): void;
  now(): number;
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
}

interface Running {
  handle: ReturnType<typeof setInterval>;
  lastTouchedAt: number;
  send: () => Promise<void>;
}

const systemClock: TypingHeartbeatClock = {
  clearInterval: (handle) => clearInterval(handle),
  now: () => Date.now(),
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    // A typing timer must never keep a draining worker alive.
    handle.unref?.();
    return handle;
  },
};

function sendQuietly(send: () => Promise<void>): void {
  // Eve's `startTyping` already logs and swallows failures; this only guards a rejected stub.
  send().catch(() => undefined);
}

export function createTelegramTypingHeartbeat(
  clock: TypingHeartbeatClock = systemClock,
  options: { idleLimitMs?: number; intervalMs?: number } = {},
) {
  const intervalMs = options.intervalMs ?? TYPING_INTERVAL_MS;
  const idleLimitMs = options.idleLimitMs ?? TYPING_IDLE_LIMIT_MS;
  const running = new Map<string, Running>();

  function stop(key: string): void {
    const turn = running.get(key);
    if (!turn) return;
    clock.clearInterval(turn.handle);
    running.delete(key);
  }

  return {
    /** Shows the indicator now and keeps it on; repeated calls only refresh the turn. */
    touch(key: string, send: () => Promise<void>): void {
      const existing = running.get(key);
      if (existing) {
        existing.lastTouchedAt = clock.now();
        existing.send = send;
        return;
      }
      const turn: Running = {
        handle: clock.setInterval(() => {
          if (clock.now() - turn.lastTouchedAt > idleLimitMs) stop(key);
          else sendQuietly(turn.send);
        }, intervalMs),
        lastTouchedAt: clock.now(),
        send,
      };
      running.set(key, turn);
      sendQuietly(send);
    },
    stop,
    /** Turns with a live timer, for tests and diagnostics. */
    size(): number {
      return running.size;
    },
  };
}

export const telegramTypingHeartbeat = createTelegramTypingHeartbeat();

export function startsTypingHeartbeat(input: {
  chatType: unknown;
  memoryReview: boolean;
  scheduled: boolean;
}): boolean {
  return input.chatType === "private" && !input.scheduled && !input.memoryReview;
}

interface TurnContext {
  session: { auth: SessionContext["session"]["auth"]; id: string; turn: { id: string } };
}

/**
 * Starts or refreshes the indicator of this turn. `afterNotice`: a progress notice has just gone
 * out, so a group turn has committed to answering and may show typing as well.
 */
export function keepTelegramTurnTyping(
  channel: { telegram: { startTyping(): Promise<void> } },
  ctx: TurnContext,
  options: { afterNotice?: boolean } = {},
): void {
  const scheduled = isScheduledSession(ctx);
  const allowed = options.afterNotice
    ? !scheduled
    : startsTypingHeartbeat({
      chatType: ctx.session.auth.current?.attributes.telegramChatType,
      memoryReview: isMemoryReviewSession(ctx),
      scheduled,
    });
  if (!allowed) return;
  telegramTypingHeartbeat.touch(progressNoticeKey(ctx.session.id, ctx.session.turn.id), () => channel.telegram.startTyping());
}

export function stopTelegramTurnTyping(ctx: { session: { id: string; turn: { id: string } } }): void {
  telegramTypingHeartbeat.stop(progressNoticeKey(ctx.session.id, ctx.session.turn.id));
}
