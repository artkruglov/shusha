/**
 * Патч проверки компакции Eve: каждое решение пишется в лог с числами, по которым оно принято,
 * и с сессией и ходом. Без этого промпт мог вырасти до 133k токенов при пороге 120k, и в логе не
 * было ни слова, почему компакции нет (upstream nyxandro 14a014d).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Eve не экспортирует харнесс; проверяется пропатченный runtime-модуль.
const { shouldCompact } = await import(`${process.cwd()}/node_modules/eve/dist/src/harness/compaction.js`) as {
  shouldCompact(messages: unknown[], config: unknown, identity?: { sessionId?: string; turnId?: string }): boolean;
};

const config = { threshold: 1_000_000 };

describe("Eve compaction check", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs the decision with the session and turn it belongs to", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const compact = shouldCompact([{ content: "привет", role: "user" }], config, { sessionId: "wrun_1", turnId: "turn_1" });

    expect(compact).toBe(false);
    const entry = JSON.parse(String(info.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(entry).toMatchObject({
      code: "AGENT_COMPACTION_CHECK", compact: false, messages: 1, sessionId: "wrun_1", threshold: 1_000_000, turnId: "turn_1",
    });
  });

  it("still decides and logs when the caller passes no identity", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect(shouldCompact([{ content: "привет", role: "user" }], config)).toBe(false);

    expect(JSON.parse(String(info.mock.calls.at(-1)?.[0]))).toMatchObject({ sessionId: null, turnId: null });
  });

  it("asks for compaction once the estimate passes the threshold", () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect(shouldCompact([{ content: "я".repeat(20_000), role: "user" }], { threshold: 100 })).toBe(true);
  });
});
