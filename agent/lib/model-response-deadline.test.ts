/**
 * Model response deadline tests.
 *
 * Constructs covered:
 * - A provider that does not start answering is cut off with a stable application error.
 * - A stream that stops sending is cut off; one that keeps sending may run longer than the limit.
 * - The caller's own cancellation still reaches the request.
 */
import { describe, expect, it } from "vitest";

import { withResponseDeadlines } from "./model-response-deadline.js";

const LIMITS = { idleMs: 60, startMs: 60 };

function never(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("model response deadlines", () => {
  it("cuts off a provider that never starts answering", async () => {
    const fetchWithDeadline = withResponseDeadlines(async (_input, init) => await never(init?.signal), LIMITS);
    await expect(fetchWithDeadline("https://api.deepseek.com/responses", {}))
      .rejects.toMatchObject({ code: "AGENT_MODEL_RESPONSE_TIMEOUT" });
  });

  it("cuts off a stream that stops sending", async () => {
    const fetchWithDeadline = withResponseDeadlines(async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
      },
    })), LIMITS);
    const response = await fetchWithDeadline("https://api.deepseek.com/responses", {});
    await expect(response.text()).rejects.toMatchObject({ code: "AGENT_MODEL_RESPONSE_TIMEOUT" });
  });

  it("lets a stream that keeps sending run past the limit", async () => {
    const fetchWithDeadline = withResponseDeadlines(async () => {
      let sent = 0;
      return new Response(new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          if (sent++ < 6) controller.enqueue(new TextEncoder().encode("x"));
          else controller.close();
        },
      }));
    }, LIMITS);
    const response = await fetchWithDeadline("https://api.deepseek.com/responses", {});
    expect(await response.text()).toBe("xxxxxx");
  });

  it("passes the caller's cancellation through", async () => {
    const caller = new AbortController();
    const fetchWithDeadline = withResponseDeadlines(async (_input, init) => await never(init?.signal), { idleMs: 10_000, startMs: 10_000 });
    const pending = fetchWithDeadline("https://api.deepseek.com/responses", { signal: caller.signal });
    caller.abort(new Error("turn cancelled"));
    await expect(pending).rejects.toThrow("turn cancelled");
  });
});
