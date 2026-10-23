/**
 * Session handoff "shown" mark tests.
 *
 * Constructs covered:
 * - Only a turn whose trusted attributes say it carries the handoff marks it shown.
 * - A failing mark or a turn without an application session is logged by code, never thrown.
 */
import { describe, expect, it, vi } from "vitest";

import { markSessionHandoffShown } from "./session-handoff-shown.js";

function context(attributes: Record<string, unknown>) {
  return { session: { auth: { current: { attributes } }, id: "wrun_1" } } as unknown as Parameters<typeof markSessionHandoffShown>[0];
}

describe("markSessionHandoffShown", () => {
  it("marks the handoff shown for the turn that carries it", async () => {
    const markShown = vi.fn().mockResolvedValue(undefined);
    await markSessionHandoffShown(context({ applicationSessionId: "session-2", sessionHandoffCarried: "true" }), markShown);
    expect(markShown).toHaveBeenCalledWith("session-2");
    await markSessionHandoffShown(context({ applicationSessionId: "session-2" }), markShown);
    await markSessionHandoffShown(context({ applicationSessionId: "session-2", sessionHandoffCarried: "false" }), markShown);
    expect(markShown).toHaveBeenCalledTimes(1);
  });

  it("logs a failure by code and never throws into the turn", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(markSessionHandoffShown(context({ applicationSessionId: "session-2", sessionHandoffCarried: "true" }), vi.fn().mockRejectedValue(new Error("db down"))))
      .resolves.toBeUndefined();
    expect(error.mock.calls.at(-1)?.[0]).toContain("AGENT_SESSION_HANDOFF_MARK_FAILED");
    expect(error.mock.calls.at(-1)?.[0]).not.toContain("db down");
    const markShown = vi.fn();
    await markSessionHandoffShown(context({ sessionHandoffCarried: "true" }), markShown);
    expect(markShown).not.toHaveBeenCalled();
    expect(error.mock.calls.at(-1)?.[0]).toContain("AGENT_SESSION_CONTEXT_INVALID");
  });
});
