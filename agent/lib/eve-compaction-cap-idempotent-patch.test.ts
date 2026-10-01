/**
 * Eve compaction tool-result cap idempotence patch tests.
 *
 * Constructs covered:
 * - A tool result already truncated by compaction is left as is by the next compaction, so the
 *   old history keeps its bytes and the provider prompt cache survives repeated compactions.
 * - A first pass still truncates an oversized result exactly once.
 *
 * Eve 0.40.0 truncated to 2 000 characters of the JSON output and wrapped it in a marker; the
 * wrapped value is longer than 2 000 again, so every later compaction truncated the truncation.
 * Production (17–25 сентября 2026): 67 compactions, a 76k-token cache miss after each, and by the
 * ninth pass nothing but nested markers left of the result.
 */
import { describe, expect, it } from "vitest";

// Eve does not export the harness; the patched runtime module is exercised directly.
const { compactMessages } = await import(`${process.cwd()}/node_modules/eve/dist/src/harness/compaction.js`) as {
  compactMessages(messages: unknown[], model: unknown, config: unknown, ...rest: unknown[]): Promise<unknown[]>;
};

const MARKER = "[Truncated by eve:";

type ToolMessage = { content: Array<{ output: { type: string; value: string } }>; role: "tool" };

function history(): unknown[] {
  return [
    { content: "привет", role: "user" },
    { content: [{ input: {}, toolCallId: "c1", toolName: "list_group_history", type: "tool-call" }], role: "assistant" },
    { content: [{ output: { type: "text", value: "x".repeat(5_000) }, toolCallId: "c1", toolName: "list_group_history", type: "tool-result" }], role: "tool" },
    { content: "ок", role: "assistant" },
    ...Array.from({ length: 12 }, (_, i) => ({ content: `сообщение ${i}`, role: "user" })),
  ];
}

// A threshold nobody reaches keeps compaction on the tool-result cap heuristic, no model call.
const CONFIG = { recentWindowSize: 10, threshold: 1e9, thresholdPercent: 0.75 };
const toolOutput = (messages: unknown[]) => (messages.find((m) => (m as { role: string }).role === "tool") as ToolMessage).content[0]!.output;

describe("Eve compaction tool-result cap", () => {
  it("truncates an oversized result once and leaves it byte-identical on later compactions", async () => {
    const first = await compactMessages(history(), null, CONFIG);
    const second = await compactMessages(first, null, CONFIG);
    const third = await compactMessages(second, null, CONFIG);

    const once = toolOutput(first);
    expect(once.value.startsWith(MARKER)).toBe(true);
    expect(once.value.split(MARKER)).toHaveLength(2);
    expect(JSON.stringify(toolOutput(second))).toBe(JSON.stringify(once));
    expect(JSON.stringify(toolOutput(third))).toBe(JSON.stringify(once));
  });
});
