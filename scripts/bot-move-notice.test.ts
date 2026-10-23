import { describe, expect, it, vi } from "vitest";

import { runBotMoveNotice } from "./bot-move-notice-core.ts";

const TEXT = "Я переехала: теперь меня зовут Юна. Нажмите «Старт» здесь: https://t.me/yuna_agent";

function dependencies() {
  const log = new Map<string, string>();
  const deps = {
    alreadyNotified: vi.fn(async () => new Set(log.keys())),
    pause: vi.fn(async () => {}),
    recipients: vi.fn(async () => ["1", "2", "3", "2"]),
    record: vi.fn(async (chatId: string, outcome: string) => { log.set(chatId, outcome); }),
    send: vi.fn(async (_chatId: string, _text: string): Promise<"sent" | "blocked"> => "sent"),
  };
  return deps;
}

describe("runBotMoveNotice", () => {
  it("sends nothing without send and counts each person once", async () => {
    const deps = dependencies();
    const result = await runBotMoveNotice({ newUsername: "yuna_agent", send: false, text: TEXT }, deps);
    expect(result).toEqual({ blocked: 0, failed: 0, recipients: 3, sent: 0, skipped: 0 });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("delivers once per person: a second run skips everyone it reached, a failure is tried again", async () => {
    const deps = dependencies();
    deps.send.mockImplementation(async (chatId: string) => {
      if (chatId === "2") return "blocked";
      if (chatId === "3" && deps.send.mock.calls.length <= 3) throw new Error("timeout");
      return "sent";
    });
    expect(await runBotMoveNotice({ newUsername: "yuna_agent", send: true, text: TEXT }, deps))
      .toEqual({ blocked: 1, failed: 1, recipients: 3, sent: 1, skipped: 0 });
    expect(await runBotMoveNotice({ newUsername: "yuna_agent", send: true, text: TEXT }, deps))
      .toEqual({ blocked: 0, failed: 0, recipients: 3, sent: 1, skipped: 2 });
    expect(deps.send).toHaveBeenCalledTimes(4);
  });

  it("refuses a text without the link to the new bot", async () => {
    const deps = dependencies();
    await expect(runBotMoveNotice({ newUsername: "yuna_agent", send: true, text: "Я переехала к Юне" }, deps))
      .rejects.toThrow(/AGENT_BOT_MOVE_LINK_MISSING/);
    expect(deps.send).not.toHaveBeenCalled();
  });
});
