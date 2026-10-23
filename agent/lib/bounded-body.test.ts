/**
 * Bounded response body contract tests.
 *
 * Constructs covered:
 * - A declared Content-Length above the cap fails before any byte is read.
 * - A stream without an honest Content-Length is cut off at the cap and cancelled.
 * - A response without a body reads as empty.
 */
import { describe, expect, it } from "vitest";

import { readBoundedBody } from "./bounded-body.js";

const tooLarge = () => new Error("too large");

function streamOf(chunks: readonly Uint8Array[], onCancel: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
    cancel: onCancel,
  });
}

describe("readBoundedBody", () => {
  it("returns the whole body under the cap", async () => {
    const body = await readBoundedBody(new Response("hello"), 5, tooLarge);
    expect(body.toString("utf8")).toBe("hello");
  });

  it("refuses a declared length above the cap before reading", async () => {
    let cancelled = false;
    const response = new Response(streamOf([new Uint8Array(1)], () => { cancelled = true; }), {
      headers: { "content-length": "10" },
    });
    await expect(readBoundedBody(response, 5, tooLarge)).rejects.toThrow("too large");
    expect(cancelled).toBe(true);
  });

  it("cuts a stream with a dishonest length at the cap and cancels it", async () => {
    let cancelled = false;
    // An endless source: only cancellation stops it.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(4)); },
      cancel() { cancelled = true; },
    });
    const response = new Response(endless, {
      headers: { "content-length": "1" },
    });
    await expect(readBoundedBody(response, 5, tooLarge)).rejects.toThrow("too large");
    expect(cancelled).toBe(true);
  });

  it("reads a response without a body as empty", async () => {
    expect((await readBoundedBody(new Response(null), 5, tooLarge)).byteLength).toBe(0);
  });
});
