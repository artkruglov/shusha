/**
 * Step status of a long turn.
 *
 * Constructs covered:
 * - Steps are described from tool names, with a search query or a domain; bookkeeping shows nothing.
 * - Finished steps carry ✓, the current batch …, repeats are counted and old steps folded.
 * - A turn faster than the delay never shows a status; a slower one gets one message, edited no more
 *   often than the gap and deleted on close, also when close arrives while the send is in flight.
 * - A refused send is not retried on every step.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createTelegramStepStatus,
  describeTelegramStep,
  renderTelegramSteps,
  type TelegramStepStatusClock,
} from "./telegram-step-status.js";

function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: TelegramStepStatusClock = {
    clearTimeout: (handle) => void timers.delete(handle as unknown as number),
    now: () => now,
    setTimeout: (callback, ms) => {
      id += 1;
      timers.set(id, { at: now + ms, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
  };
  return {
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await flush();
      }
      now = end;
      await flush();
    },
    clock,
  };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function transport() {
  return {
    edit: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(77),
  };
}

const search = (query: string) => ({ input: { query }, kind: "tool-call", toolName: "web_search" });
const fetchPage = (url: string) => ({ input: { url }, kind: "tool-call", toolName: "web_fetch" });

describe("describeTelegramStep", () => {
  it("names the step from the tool, its query or its domain", () => {
    expect(describeTelegramStep(search("цены  Третьяковка"))).toBe("🔎 Ищу: цены Третьяковка");
    expect(describeTelegramStep(fetchPage("https://www.tretyakov.ru/visit"))).toBe("🌐 Открываю tretyakov.ru");
    expect(describeTelegramStep(fetchPage("не адрес"))).toBe("🌐 Открываю сайт");
    expect(describeTelegramStep({ kind: "subagent-call" })).toBe("🤝 Подключаю помощника");
    expect(describeTelegramStep({ input: {}, kind: "tool-call", toolName: "remember" })).toBeNull();
    expect(describeTelegramStep({ input: {}, kind: "load-skill" })).toBeNull();
    expect(Array.from(describeTelegramStep(search("я".repeat(80)))!.replace("🔎 Ищу: ", ""))).toHaveLength(40);
  });
});

describe("renderTelegramSteps", () => {
  it("marks done steps, counts repeats and folds old ones", () => {
    expect(renderTelegramSteps([
      { batch: 1, line: "🔎 Ищу в интернете" },
      { batch: 2, line: "🔎 Ищу в интернете" },
      { batch: 3, line: "🌐 Открываю a.ru" },
      { batch: 3, line: "🌐 Открываю b.ru" },
    ])).toBe("🔎 Ищу в интернете ×2 ✓\n🌐 Открываю a.ru…\n🌐 Открываю b.ru…");

    const many = Array.from({ length: 9 }, (_, index) => ({ batch: index + 1, line: `шаг ${index + 1}` }));
    const text = renderTelegramSteps(many).split("\n");
    expect(text[0]).toBe("✓ ещё шагов: 3");
    expect(text.at(-1)).toBe("шаг 9…");
    expect(text).toHaveLength(7);
  });
});

describe("createTelegramStepStatus", () => {
  it("shows nothing for a turn that answers before the delay", async () => {
    const fake = fakeClock();
    const status = createTelegramStepStatus(fake.clock, { appearAfterMs: 8_000 });
    const telegram = transport();

    status.begin("turn");
    status.record("turn", [search("погода")], telegram, 3_000);
    await fake.advance(5_000);
    await status.close("turn");
    await fake.advance(10_000);

    expect(telegram.send).not.toHaveBeenCalled();
    expect(telegram.remove).not.toHaveBeenCalled();
  });

  it("sends once after the delay, edits within the gap and deletes on close", async () => {
    const fake = fakeClock();
    const status = createTelegramStepStatus(fake.clock, { appearAfterMs: 8_000 });
    const telegram = transport();

    status.begin("turn");
    status.record("turn", [search("билеты")], telegram, 3_000);
    await fake.advance(8_000);
    expect(telegram.send).toHaveBeenCalledWith("🔎 Ищу: билеты…");

    status.record("turn", [fetchPage("https://tretyakov.ru")], telegram, 3_000);
    status.record("turn", [fetchPage("https://kassir.ru")], telegram, 3_000);
    await flush();
    expect(telegram.edit).not.toHaveBeenCalled();
    await fake.advance(3_000);
    expect(telegram.edit).toHaveBeenCalledTimes(1);
    expect(telegram.edit).toHaveBeenCalledWith(77, "🔎 Ищу: билеты ✓\n🌐 Открываю tretyakov.ru ✓\n🌐 Открываю kassir.ru…");

    await status.close("turn");
    expect(telegram.remove).toHaveBeenCalledWith(77);
    expect(status.size()).toBe(0);
  });

  it("deletes a status whose send was still in flight at close", async () => {
    const fake = fakeClock();
    const status = createTelegramStepStatus(fake.clock, { appearAfterMs: 0 });
    const telegram = transport();
    let finishSend: (id: number) => void = () => undefined;
    telegram.send.mockReturnValue(new Promise<number>((resolve) => { finishSend = resolve; }));

    status.begin("turn");
    status.record("turn", [search("x")], telegram, 3_000);
    await flush();
    const closing = status.close("turn");
    finishSend(91);
    await closing;

    expect(telegram.remove).toHaveBeenCalledWith(91);
  });

  it("gives up after Telegram refused the first send", async () => {
    const fake = fakeClock();
    const status = createTelegramStepStatus(fake.clock, { appearAfterMs: 0 });
    const telegram = transport();
    telegram.send.mockResolvedValue(null);

    status.begin("turn");
    status.record("turn", [search("x")], telegram, 0);
    await flush();
    status.record("turn", [search("y")], telegram, 0);
    await fake.advance(10_000);
    await status.close("turn");

    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(telegram.remove).not.toHaveBeenCalled();
  });

  it("ignores steps that describe nothing", async () => {
    const fake = fakeClock();
    const status = createTelegramStepStatus(fake.clock, { appearAfterMs: 0 });
    const telegram = transport();

    status.record("turn", [{ input: {}, kind: "tool-call", toolName: "remember" }], telegram, 0);
    await fake.advance(10_000);

    expect(telegram.send).not.toHaveBeenCalled();
    expect(status.size()).toBe(0);
  });
});
