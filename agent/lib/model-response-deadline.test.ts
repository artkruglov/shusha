/**
 * Model response deadline tests.
 *
 * Constructs covered:
 * - A provider that does not start answering is cut off with a stable application error.
 * - A stream that stops sending is cut off; one that keeps sending may run longer than the limit.
 * - SSE keep-alive comments and blank lines do not count as answering, before or after the first event.
 * - A `data:` field split across chunks still counts; the bytes pass through unchanged.
 * - Consumer cancellation clears the timers; the caller's own cancellation still reaches the request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { withResponseDeadlines } from "./model-response-deadline.js";

const LIMITS = { idleMs: 60, startMs: 60 };
const SSE_HEADERS = { "content-type": "text/event-stream" };
const encoder = new TextEncoder();

function never(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** A body that sends `chunks` one per `everyMs`, then closes; it errors when the request is aborted. */
function paced(chunks: readonly string[], everyMs: number, init: RequestInit | undefined, headers?: HeadersInit): Response {
  let sent = 0;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
    },
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, everyMs));
      if (sent < chunks.length) controller.enqueue(encoder.encode(chunks[sent++]!));
      else controller.close();
    },
  }), headers === undefined ? {} : { headers });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("model response deadlines", () => {
  it("cuts off a provider that never starts answering", async () => {
    const fetchWithDeadline = withResponseDeadlines(async (_input, init) => await never(init?.signal), LIMITS);
    await expect(fetchWithDeadline("https://api.deepseek.com/responses", {}))
      .rejects.toMatchObject({ code: "AGENT_MODEL_RESPONSE_TIMEOUT" });
  });

  it("cuts off a stream that stops sending", async () => {
    const fetchWithDeadline = withResponseDeadlines(async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
      },
    }), { headers: SSE_HEADERS }), LIMITS);
    const response = await fetchWithDeadline("https://api.deepseek.com/responses", {});
    await expect(response.text()).rejects.toMatchObject({
      code: "AGENT_MODEL_RESPONSE_TIMEOUT",
      message: expect.stringContaining("перестала присылать"),
    });
  });

  it("lets a stream that keeps sending run past the limit", async () => {
    const fetchWithDeadline = withResponseDeadlines(async (_input, init) => paced(["x", "x", "x", "x", "x", "x"], 30, init), LIMITS);
    const response = await fetchWithDeadline("https://api.deepseek.com/responses", {});
    expect(await response.text()).toBe("xxxxxx");
  });

  it("cuts off a 200 stream that only sends keep-alive comments", async () => {
    // 23 октября 2026: DeepSeek under load answers 200 at once and then holds the stream with comments.
    const keepAlive = Array.from({ length: 20 }, () => ": keep-alive\n\n");
    const fetchWithDeadline = withResponseDeadlines(
      async (_input, init) => paced(keepAlive, 20, init, SSE_HEADERS),
      { idleMs: 10_000, startMs: 100 },
    );
    const response = await fetchWithDeadline("https://api.deepseek.com/responses", {});
    await expect(response.text()).rejects.toMatchObject({
      code: "AGENT_MODEL_RESPONSE_TIMEOUT",
      message: expect.stringContaining("не начала отвечать"),
    });
  });

  it("cuts off a stream that falls to keep-alive comments after its first event", async () => {
    const chunks = ["data: {\"type\":\"response.created\"}\n\n", ...Array.from({ length: 20 }, () => ": keep-alive\n\n\n")];
    const fetchWithDeadline = withResponseDeadlines(
      async (_input, init) => paced(chunks, 20, init, SSE_HEADERS),
      { idleMs: 100, startMs: 10_000 },
    );
    const response = await fetchWithDeadline("https://api.deepseek.com/responses", {});
    await expect(response.text()).rejects.toMatchObject({
      code: "AGENT_MODEL_RESPONSE_TIMEOUT",
      message: expect.stringContaining("перестала присылать"),
    });
  });

  it("cuts off a plain answer that only sends blank lines", async () => {
    const fetchWithDeadline = withResponseDeadlines(
      async (_input, init) => paced(Array.from({ length: 20 }, () => "\n"), 20, init, { "content-type": "application/json" }),
      { idleMs: 10_000, startMs: 100 },
    );
    const response = await fetchWithDeadline("https://api.deepseek.com/responses", {});
    await expect(response.text()).rejects.toMatchObject({ code: "AGENT_MODEL_RESPONSE_TIMEOUT" });
  });

  it("keeps a stream of data events alive and passes the bytes through unchanged", async () => {
    const chunks = Array.from({ length: 8 }, (_unused, index) => `event: delta\ndata: {"n":${index}}\n\n`);
    const fetchWithDeadline = withResponseDeadlines(async (_input, init) => paced(chunks, 30, init, SSE_HEADERS), LIMITS);
    const response = await fetchWithDeadline("https://api.deepseek.com/responses", {});
    expect(await response.text()).toBe(chunks.join(""));
  });

  it("counts a data field split across chunks", async () => {
    // Each pair of chunks carries one event whose "data:" is cut in the middle; without line state
    // neither half looks like data, the comments in between would not reset, and the idle deadline fires.
    const chunks = Array.from({ length: 6 }, (_unused, index) => [": keep-alive\n\nda", `ta: {"n":${index}}\n\n`]).flat();
    const fetchWithDeadline = withResponseDeadlines(
      async (_input, init) => paced(chunks, 30, init, SSE_HEADERS),
      { idleMs: 80, startMs: 80 },
    );
    const response = await fetchWithDeadline("https://api.deepseek.com/responses", {});
    expect(await response.text()).toBe(chunks.join(""));
  });

  it("clears its timers when the consumer cancels the body", async () => {
    vi.useFakeTimers();
    const fetchWithDeadline = withResponseDeadlines(
      async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: first\n\n"));
        },
      }), { headers: SSE_HEADERS }),
      { idleMs: 60_000, startMs: 60_000 },
    );
    const response = await fetchWithDeadline("https://api.deepseek.com/responses", {});
    const reader = response.body!.getReader();
    await reader.read();
    expect(vi.getTimerCount()).toBe(1);
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the caller's cancellation through", async () => {
    const caller = new AbortController();
    const fetchWithDeadline = withResponseDeadlines(async (_input, init) => await never(init?.signal), { idleMs: 10_000, startMs: 10_000 });
    const pending = fetchWithDeadline("https://api.deepseek.com/responses", { signal: caller.signal });
    caller.abort(new Error("turn cancelled"));
    await expect(pending).rejects.toThrow("turn cancelled");
  });
});
