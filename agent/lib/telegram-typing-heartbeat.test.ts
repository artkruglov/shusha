/**
 * «Печатает…» heartbeat of a turn.
 *
 * Constructs covered:
 * - The first touch shows the indicator at once and repeats it on every interval.
 * - Touching a running turn does not start a second timer.
 * - Stop ends the repeats; a turn no longer touched ends on its own after the idle limit.
 * - Only a person's private-chat turn starts the indicator by itself.
 */
import { describe, expect, it, vi } from "vitest";

import { createTelegramTypingHeartbeat, startsTypingHeartbeat } from "./telegram-typing-heartbeat.js";

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { callback: () => void; ms: number; next: number }>();
  let id = 0;
  return {
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.next <= end).sort((a, b) => a[1].next - b[1].next)[0];
        if (!due) break;
        now = due[1].next;
        due[1].next += due[1].ms;
        due[1].callback();
      }
      now = end;
    },
    clock: {
      clearInterval: (handle: ReturnType<typeof setInterval>) => void timers.delete(handle as unknown as number),
      now: () => now,
      setInterval: (callback: () => void, ms: number) => {
        id += 1;
        timers.set(id, { callback, ms, next: now + ms });
        return id as unknown as ReturnType<typeof setInterval>;
      },
    },
    timers,
  };
}

describe("telegram typing heartbeat", () => {
  it("shows typing at once and keeps it on until stopped", () => {
    const fake = fakeClock();
    const heartbeat = createTelegramTypingHeartbeat(fake.clock, { idleLimitMs: 60_000, intervalMs: 4_500 });
    const send = vi.fn().mockResolvedValue(undefined);

    heartbeat.touch("turn-1", send);
    expect(send).toHaveBeenCalledTimes(1);
    fake.advance(9_000);
    expect(send).toHaveBeenCalledTimes(3);

    heartbeat.touch("turn-1", send);
    expect(fake.timers.size).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);

    heartbeat.stop("turn-1");
    fake.advance(20_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(heartbeat.size()).toBe(0);
  });

  it("ends a turn that is no longer touched after the idle limit", () => {
    const fake = fakeClock();
    const heartbeat = createTelegramTypingHeartbeat(fake.clock, { idleLimitMs: 10_000, intervalMs: 4_500 });
    const send = vi.fn().mockResolvedValue(undefined);

    heartbeat.touch("turn-1", send);
    fake.advance(30_000);

    expect(send).toHaveBeenCalledTimes(3);
    expect(heartbeat.size()).toBe(0);
    expect(fake.timers.size).toBe(0);
  });

  it("survives a send that rejects", () => {
    const fake = fakeClock();
    const heartbeat = createTelegramTypingHeartbeat(fake.clock, { intervalMs: 4_500 });

    expect(() => heartbeat.touch("turn-1", () => Promise.reject(new Error("network")))).not.toThrow();
    expect(() => fake.advance(5_000)).not.toThrow();
  });

  it.each([
    [{ chatType: "private", memoryReview: false, scheduled: false }, true],
    [{ chatType: "supergroup", memoryReview: false, scheduled: false }, false],
    [{ chatType: "private", memoryReview: false, scheduled: true }, false],
    [{ chatType: "private", memoryReview: true, scheduled: false }, false],
    [{ chatType: undefined, memoryReview: false, scheduled: false }, false],
  ])("decides whether %o starts typing by itself", (input, expected) => {
    expect(startsTypingHeartbeat(input)).toBe(expected);
  });
});
