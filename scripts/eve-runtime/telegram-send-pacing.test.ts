/**
 * Tests for the outbound Telegram pacer.
 *
 * Covers: per-chat windows that never delay another chat, the global window, a 429 that pauses only its
 * own chat, the single repeat after a 429 and the environment bounds of the settings.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createTelegramSendPacer,
  pacedTelegramSend,
  telegramSendPacerSettings,
} from "./telegram-send-pacing.js";

function fakeClock() {
  let at = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => at,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      at += ms;
    },
    advance: (ms: number) => {
      at += ms;
    },
    sleeps,
  };
}

describe("createTelegramSendPacer", () => {
  it("holds a group at twenty a minute without delaying another group or a private chat", async () => {
    const clock = fakeClock();
    const pacer = createTelegramSendPacer({ groupPerMinute: 2, now: clock.now, sleep: clock.sleep });

    await pacer.acquire("sendMessage", { chat_id: -100 });
    await pacer.acquire("sendMessage", { chat_id: -100 });
    await pacer.acquire("sendMessage", { chat_id: -200 });
    await pacer.acquire("sendMessage", { chat_id: 42 });
    expect(clock.sleeps).toEqual([]);

    await pacer.acquire("sendMessage", { chat_id: -100 });
    expect(clock.sleeps).toEqual([60_000]);
  });

  it("spaces messages to one private chat by the configured gap", async () => {
    const clock = fakeClock();
    const pacer = createTelegramSendPacer({ now: clock.now, privateGapMs: 250, sleep: clock.sleep });

    await pacer.acquire("sendMessage", { chat_id: 42 });
    await pacer.acquire("sendMessage", { chat_id: 42 });
    expect(clock.sleeps).toEqual([250]);
  });

  it("lets methods that send nothing pass at once", async () => {
    const clock = fakeClock();
    const pacer = createTelegramSendPacer({ globalPerSecond: 1, now: clock.now, sleep: clock.sleep });

    await pacer.acquire("sendMessage", { chat_id: 1 });
    await pacer.acquire("sendChatAction", { chat_id: 2 });
    await pacer.acquire("getChat", { chat_id: 3 });
    expect(clock.sleeps).toEqual([]);
  });

  it("holds every chat to the global window", async () => {
    const clock = fakeClock();
    const pacer = createTelegramSendPacer({ globalPerSecond: 2, now: clock.now, sleep: clock.sleep });

    await pacer.acquire("sendMessage", { chat_id: 1 });
    await pacer.acquire("sendMessage", { chat_id: 2 });
    await pacer.acquire("sendMessage", { chat_id: 3 });
    expect(clock.sleeps).toEqual([1_000]);
  });

  it("pauses only the chat a 429 named", async () => {
    const clock = fakeClock();
    const pacer = createTelegramSendPacer({ now: clock.now, sleep: clock.sleep });

    pacer.retryAfter({ chat_id: -100 }, 7);
    await pacer.acquire("sendMessage", { chat_id: -200 });
    expect(clock.sleeps).toEqual([]);
    await pacer.acquire("sendMessage", { chat_id: -100 });
    expect(clock.sleeps).toEqual([7_000]);
  });

  it("caps the pause a 429 asks for at a minute", async () => {
    const clock = fakeClock();
    const pacer = createTelegramSendPacer({ now: clock.now, sleep: clock.sleep });

    pacer.retryAfter(undefined, 3_600);
    await pacer.waitForPause({ chat_id: 1 });
    expect(clock.sleeps).toEqual([60_000]);
  });
});

describe("pacedTelegramSend", () => {
  const parse = async (response: Response) => await response.json();

  it("repeats a request once after the wait a 429 named", async () => {
    const clock = fakeClock();
    const pacer = createTelegramSendPacer({ now: clock.now, sleep: clock.sleep });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const responses = [
      new Response(JSON.stringify({ ok: false, parameters: { retry_after: 3 } }), { status: 429 }),
      new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }), { status: 200 }),
    ];
    const send = vi.fn(async () => responses.shift()!);

    const result = await pacedTelegramSend("sendMessage", { chat_id: 42 }, send, parse, pacer);

    expect(send).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
    expect(clock.sleeps).toContain(3_000);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AGENT_TELEGRAM_RATE_LIMITED"));
    error.mockRestore();
  });

  it("does not repeat a 429 that names no wait", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const send = vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 429 }));

    const result = await pacedTelegramSend("sendMessage", { chat_id: 42 }, send, parse, createTelegramSendPacer());

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
    error.mockRestore();
  });
});

describe("telegramSendPacerSettings", () => {
  it("uses Telegram-safe defaults and rejects values above Telegram's limits", () => {
    expect(telegramSendPacerSettings({})).toEqual({ globalPerSecond: 25, groupPerMinute: 20, privateGapMs: 250 });
    expect(() => telegramSendPacerSettings({ TELEGRAM_SEND_GROUP_PER_MINUTE: "21" }))
      .toThrow("AGENT_RUNTIME_TUNING_INVALID");
  });
});
