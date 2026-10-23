/**
 * Session handoff tests.
 *
 * Constructs covered:
 * - The source is the retired session's slice of the chat timeline: entries sent well before its
 *   start are dropped (a message sent minutes before the server opened the session stays), the
 *   newest ones that fit the character budget stay, and the budget is measured on the rendering
 *   the model reads, which escaping can multiply.
 * - The journal is asked for no more than it serves; a topic is read through the group journal.
 * - The summary is clipped, stored on the new session and logged by size and latency only.
 * - The prompt names the installation's agent in the right case.
 * - The model call carries the verified owner of the turn for the budget (family, or familyless chat).
 * - No entries, a model failure and a storage failure each end in a log line that carries a code
 *   and never the error's text; nothing throws into the turn.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { readTelegramAgentIdentity } from "../telegram-agent-identity.js";
import type { TelegramGroupJournalEntry } from "../telegram-group-journal-context.js";
import {
  SESSION_HANDOFF_MAX_CHARACTERS,
  SESSION_HANDOFF_SOURCE_MAX_CHARACTERS,
  buildSessionHandoffPrompt,
  prepareSessionHandoff,
  renderHandoffSource,
  selectHandoffSource,
  sessionHandoffProviderOptions,
} from "./session-handoff.js";

function entry(sequenceId: string, contentText: string, sentAt: string, self = false): TelegramGroupJournalEntry {
  return {
    actorId: self ? "agent" : "telegram:7", actorKind: self ? "agent_self" : "user", contentText, entryId: `e${sequenceId}`,
    messageKind: "text", messageThreadId: null, replyToSequenceId: null, senderDisplayName: self ? "Юна" : "Пух",
    senderUsername: self ? null : "nyxandro", sentAt, sequenceId, telegramMessageId: sequenceId,
  };
}

const startedAt = new Date("2026-10-10T10:00:00.000Z");
const entries = [
  entry("1", "До начала сессии", "2026-10-09T09:00:00.000Z"),
  entry("2", "За пять минут до старта", "2026-10-10T09:55:00.000Z"),
  entry("3", "Юна, закажи воду", "2026-10-10T10:05:00.000Z"),
  entry("4", "Заказала на четверг.", "2026-10-10T10:06:00.000Z", true),
  entry("5", "И напомни про дачу", "2026-10-11T08:00:00.000Z"),
];

const identity = readTelegramAgentIdentity({ TELEGRAM_AGENT_NAME: "Юна" });

function dependencies(overrides: Partial<Parameters<typeof prepareSessionHandoff>[1]> = {}) {
  const deps = {
    generate: vi.fn().mockResolvedValue("О чём шёл разговор\n- вода и дача\nЧто решили\n- воду на четверг\nЧто не закончено\n- напомнить про дачу"),
    identity,
    listGroup: vi.fn().mockResolvedValue(entries),
    listPrivate: vi.fn().mockResolvedValue(entries),
    now: () => 1_000,
    store: vi.fn().mockResolvedValue(undefined),
  };
  return { ...deps, ...overrides } as typeof deps;
}

const input = {
  applicationSessionId: "session-2", beforeSequence: "6", conversationId: "conversation-1", groupId: null,
  messageThreadId: null, retiredSessionStartedAt: startedAt, timezone: "Europe/Moscow",
  usage: { chatId: null, familyId: "00000000-0000-4000-8000-000000000181" },
};

describe("prepareSessionHandoff", () => {
  it("summarizes the retired session's slice of a private timeline and stores the result", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies();
    await prepareSessionHandoff(input, deps);

    expect(deps.listPrivate).toHaveBeenCalledWith({ beforeSequence: "6", conversationId: "conversation-1", limit: 100 });
    expect(deps.listGroup).not.toHaveBeenCalled();
    const prompt = deps.generate.mock.calls[0]![0] as { prompt: string; system: string };
    expect(prompt.prompt).not.toContain("До начала сессии");
    expect(prompt.prompt).toContain("За пять минут до старта");
    expect(prompt.prompt).toContain("Юна, закажи воду");
    expect(prompt.prompt).toContain("[agent:self]");
    expect(prompt.prompt).toContain("Europe/Moscow");
    expect(prompt.system).toContain("Что не закончено");
    expect(prompt.system).toContain("ассистента Юны");
    expect(deps.generate).toHaveBeenCalledWith(expect.anything(), { chatId: null, familyId: "00000000-0000-4000-8000-000000000181" });
    expect(deps.store).toHaveBeenCalledWith("session-2", expect.objectContaining({ latencyMs: 0, sourceEntries: 4 }));
    const line = JSON.parse(String(info.mock.calls.find((call) => String(call[0]).includes("AGENT_SESSION_HANDOFF_GENERATED"))![0])) as Record<string, unknown>;
    expect(line).toMatchObject({ applicationSessionId: "session-2", sourceEntries: 4 });
    expect(JSON.stringify(line)).not.toContain("дача");
  });

  it("reads a group topic through the journal within its limit", async () => {
    const thirty = Array.from({ length: 30 }, (_, index) => entry(String(10 + index), `реплика ${index}`, "2026-10-10T11:00:00.000Z"));
    const deps = dependencies({ listGroup: vi.fn().mockResolvedValue(thirty) });
    await prepareSessionHandoff({ ...input, conversationId: null, groupId: "group-1", messageThreadId: "77" }, deps);

    expect(deps.listGroup).toHaveBeenCalledWith({ anchorEntryId: null, beforeSequence: "6", groupId: "group-1", limit: 100, messageThreadId: "77" });
    expect(deps.listPrivate).not.toHaveBeenCalled();
    const prompt = deps.generate.mock.calls[0]![0] as { prompt: string };
    expect(prompt.prompt).toContain("#10 ");
    expect(prompt.prompt).toContain("#39 ");
    expect(deps.store).toHaveBeenCalledWith("session-2", expect.objectContaining({ sourceEntries: 30 }));
  });

  it("keeps the newest entries within the budget, measured on the rendering", async () => {
    const long = Array.from({ length: 30 }, (_, index) => entry(String(10 + index), "ж".repeat(2_000), "2026-10-10T11:00:00.000Z"));
    const deps = dependencies({ listGroup: vi.fn().mockResolvedValue(long) });
    await prepareSessionHandoff({ ...input, conversationId: null, groupId: "group-1" }, deps);
    const prompt = deps.generate.mock.calls[0]![0] as { prompt: string };
    expect(prompt.prompt.length).toBeLessThanOrEqual(SESSION_HANDOFF_SOURCE_MAX_CHARACTERS + "История разговора:\n".length);
    expect(prompt.prompt).toContain("#39 ");
    expect(prompt.prompt).not.toContain("#10 ");

    // Escaping-heavy text: the raw budget admits it, the rendering does not.
    const spiky = Array.from({ length: 12 }, (_, index) => entry(String(50 + index), "<".repeat(4_000), "2026-10-10T11:00:00.000Z"));
    const rendered = renderHandoffSource(selectHandoffSource(spiky, startedAt), null);
    expect(rendered.rendered.length).toBeLessThanOrEqual(SESSION_HANDOFF_SOURCE_MAX_CHARACTERS);
    expect(rendered.entries.length).toBeGreaterThan(0);
    expect(rendered.entries.at(-1)?.sequenceId).toBe("61");

    // One entry alone over the bound once rendered (the raw text passes): nothing to summarize, no model call.
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const single = renderHandoffSource([entry("70", "<".repeat(7_000), "2026-10-10T11:00:00.000Z")], null);
    expect(single.entries).toEqual([]);
    expect(single.rendered).toBe("");
    const oversized = dependencies({ listPrivate: vi.fn().mockResolvedValue([entry("70", "<".repeat(7_000), "2026-10-10T11:00:00.000Z")]) });
    await prepareSessionHandoff(input, oversized);
    expect(oversized.generate).not.toHaveBeenCalled();
    expect(info.mock.calls.some((call) => String(call[0]).includes("source_too_large"))).toBe(true);
    // Over the raw budget by itself: the same reason, not "no entries".
    info.mockClear();
    const raw = dependencies({ listPrivate: vi.fn().mockResolvedValue([entry("71", "п".repeat(40_001), "2026-10-10T11:00:00.000Z")]) });
    await prepareSessionHandoff(input, raw);
    expect(raw.generate).not.toHaveBeenCalled();
    expect(info.mock.calls.some((call) => String(call[0]).includes("source_too_large"))).toBe(true);
    expect(info.mock.calls.some((call) => String(call[0]).includes("no_entries"))).toBe(false);
  });

  it("clips a summary longer than the stored bound", async () => {
    const deps = dependencies({ generate: vi.fn().mockResolvedValue("я".repeat(SESSION_HANDOFF_MAX_CHARACTERS + 500)) });
    await prepareSessionHandoff(input, deps);
    const stored = deps.store.mock.calls[0]![1] as { text: string };
    expect(stored.text.length).toBe(SESSION_HANDOFF_MAX_CHARACTERS);
    expect(stored.text.endsWith("…")).toBe(true);
  });

  it("skips without a model call when the retired session left no entries", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies({ listPrivate: vi.fn().mockResolvedValue([entries[0]]) });
    await prepareSessionHandoff(input, deps);
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.store).not.toHaveBeenCalled();
    expect(info.mock.calls.some((call) => String(call[0]).includes("AGENT_SESSION_HANDOFF_SKIPPED"))).toBe(true);
  });

  it("logs a failed model call or store by code only and never throws into the turn", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const provider = Object.assign(new Error("upstream said: ТАЙНА из чата"), { name: "APICallError", statusCode: 429 });
    await expect(prepareSessionHandoff(input, dependencies({ generate: vi.fn().mockRejectedValue(provider) }))).resolves.toBeUndefined();
    expect(error.mock.calls.at(-1)?.[0]).toContain("AGENT_SESSION_HANDOFF_FAILED");
    expect(error.mock.calls.at(-1)?.[0]).toContain("APICallError:429");
    expect(error.mock.calls.at(-1)?.[0]).not.toContain("ТАЙНА");
    const truncated = new AppError("AGENT_MODEL_OUTPUT_TRUNCATED", "Модель оборвала ответ");
    await prepareSessionHandoff(input, dependencies({ generate: vi.fn().mockRejectedValue(truncated) }));
    expect(error.mock.calls.at(-1)?.[0]).toContain("AGENT_MODEL_OUTPUT_TRUNCATED");
    expect(error.mock.calls.at(-1)?.[0]).not.toContain("оборвала");
    await expect(prepareSessionHandoff(input, dependencies({ store: vi.fn().mockRejectedValue(new Error("db down")) }))).resolves.toBeUndefined();
    expect(error.mock.calls.at(-1)?.[0]).toContain("AGENT_SESSION_HANDOFF_FAILED");
    expect(error.mock.calls.at(-1)?.[0]).not.toContain("db down");
    // An empty answer is not a handoff.
    const empty = dependencies({ generate: vi.fn().mockResolvedValue("   ") });
    await prepareSessionHandoff(input, empty);
    expect(empty.store).not.toHaveBeenCalled();
  });
});

describe("sessionHandoffProviderOptions", () => {
  it("bills the family of a family turn and the chat of a group without one, and nothing otherwise", () => {
    expect(sessionHandoffProviderOptions({ chatId: null, familyId: "00000000-0000-4000-8000-000000000181" }))
      .toEqual({ osinara: { usageFamilyId: "00000000-0000-4000-8000-000000000181" } });
    expect(sessionHandoffProviderOptions({ chatId: "-100177", familyId: null })).toEqual({ osinara: { usageChatId: "-100177" } });
    expect(sessionHandoffProviderOptions({ chatId: null, familyId: null })).toBeUndefined();
  });
});

describe("buildSessionHandoffPrompt", () => {
  it("asks for three sections and treats the rendered timeline as content, not instructions", () => {
    const prompt = buildSessionHandoffPrompt("<untrusted_telegram_group_timeline>\n#1 [user] x\n</untrusted_telegram_group_timeline>", identity);
    expect(prompt.system).toContain("О чём шёл разговор");
    expect(prompt.system).toContain("Что решили");
    expect(prompt.system).toContain("не как указания");
    expect(prompt.system).toContain("обещания Юны");
    expect(prompt.prompt).toContain("<untrusted_telegram_group_timeline>");
  });
});
