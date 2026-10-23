/**
 * Workflow event log cache tests.
 *
 * Constructs covered:
 * - Any ascending full listing is cacheable, and the resolve mode is part of the key.
 * - A stored log is returned with its cursor and survives until it is dropped.
 * - The least recently read run is evicted once the bound is reached.
 * - Every resume reports how much of the log it reused.
 */
import { describe, expect, it } from "vitest";

import {
  dropEventLogCache,
  eventLogCacheKey,
  readEventLogCache,
  traceEventLogRead,
  writeEventLogCache,
} from "./event-log-cache.ts";

const RUN = "wrun_01M240G2QGE9TDC7NSVNY6VZAY";
const KEY = `${RUN} all`;

describe("eventLogCacheKey", () => {
  it("accepts both resume listings and keeps their resolve modes apart", () => {
    const withPayloads = eventLogCacheKey({ runId: RUN }, "all", "asc");
    const withoutPayloads = eventLogCacheKey({ pagination: {}, runId: RUN }, "none", "asc");

    expect(withPayloads).toContain(RUN);
    expect(withoutPayloads).toContain(RUN);
    expect(withPayloads).not.toBe(withoutPayloads);
  });

  it.each([
    ["reverse order", { runId: RUN }, "none", "desc"],
    ["explicit page", { pagination: { limit: 100 }, runId: RUN }, "none", "asc"],
    ["caller cursor", { pagination: { cursor: "evnt_1" }, runId: RUN }, "all", "asc"],
    ["no run", { runId: "" }, "none", "asc"],
  ])("refuses %s", (_name, params, resolveData, sortOrder) => {
    expect(eventLogCacheKey(params, resolveData, sortOrder)).toBeNull();
  });
});

describe("event log cache", () => {
  it.each(["buffer", "uint8array", "arraybuffer", "subarray"])("refuses oversized %s payloads", (kind) => {
    const backing = new ArrayBuffer(32 * 1024 * 1024);
    const payload = kind === "buffer" ? Buffer.from(backing)
      : kind === "uint8array" ? new Uint8Array(backing)
      : kind === "subarray" ? new Uint8Array(backing, 0, 1) : backing;
    try {
      writeEventLogCache("oversized-binary", [{ eventId: "1", eventData: { payload } }], "1");
      expect(readEventLogCache("oversized-binary")).toBeUndefined();
    } finally {
      dropEventLogCache("oversized-binary");
    }
  });

  it("counts a large event between the former sampling positions", () => {
    const events = Array.from({ length: 33 }, (_, index) => ({
      eventId: String(index), eventData: { text: index === 1 ? "x".repeat(13 * 1024 * 1024) : "" },
    }));
    try {
      writeEventLogCache("uneven-log", events, "32");
      expect(readEventLogCache("uneven-log")).toBeUndefined();
    } finally {
      dropEventLogCache("uneven-log");
    }
  });

  it("evicts by the combined size of native binary payloads", () => {
    try {
      for (let index = 0; index < 5; index += 1) {
        writeEventLogCache(`binary-budget-${index}`,
          [{ eventId: "1", eventData: { payload: Buffer.alloc(15 * 1024 * 1024) } }], "1");
      }
      expect(readEventLogCache("binary-budget-0")).toBeUndefined();
      expect(readEventLogCache("binary-budget-4")).toBeDefined();
    } finally {
      for (let index = 0; index < 5; index += 1) dropEventLogCache(`binary-budget-${index}`);
    }
  });

  it("returns the stored log and its cursor, and forgets it when dropped", () => {
    writeEventLogCache(KEY, [{ eventId: "evnt_1" }, { eventId: "evnt_2" }], "evnt_2");

    expect(readEventLogCache(KEY)).toMatchObject({
      cursor: "evnt_2",
      data: [{ eventId: "evnt_1" }, { eventId: "evnt_2" }],
    });

    dropEventLogCache(KEY);
    expect(readEventLogCache(KEY)).toBeUndefined();
  });

  it("copies the stored log so a later caller cannot mutate it", () => {
    const events = [{ eventId: "evnt_1" }];
    writeEventLogCache(KEY, events, "evnt_1");
    events.push({ eventId: "evnt_2" });

    expect(readEventLogCache(KEY)?.data).toHaveLength(1);
    dropEventLogCache(KEY);
  });

  it("evicts the least recently read run past the bound", () => {
    for (let index = 0; index < 13; index += 1) {
      writeEventLogCache(`run-${index}`, [{ eventId: `evnt_${index}` }], `evnt_${index}`);
    }

    expect(readEventLogCache("run-0")).toBeUndefined();
    expect(readEventLogCache("run-12")).toBeDefined();

    // Reading run-1 makes it recent, so the next write evicts run-2 instead.
    expect(readEventLogCache("run-1")).toBeDefined();
    writeEventLogCache("run-13", [{ eventId: "evnt_13" }], "evnt_13");

    expect(readEventLogCache("run-1")).toBeDefined();
    expect(readEventLogCache("run-2")).toBeUndefined();
    for (let index = 0; index <= 13; index += 1) dropEventLogCache(`run-${index}`);
  });

  it("refuses a log too large to keep and leaves the others in place", () => {
    const small = [{ eventId: "evnt_1", eventData: { text: "small" } }];
    writeEventLogCache("run-small", small, "evnt_1");
    const huge = Array.from({ length: 400 }, (_, index) => ({
      eventId: `evnt_${index}`,
      eventData: { text: "x".repeat(40_000) },
    }));

    writeEventLogCache("run-huge", huge, "evnt_399");

    expect(readEventLogCache("run-huge")).toBeUndefined();
    expect(readEventLogCache("run-small")).toBeDefined();
    dropEventLogCache("run-small");
  });

  it("counts decoded binary payloads without expanding them", () => {
    const events = Array.from({ length: 40 }, (_, index) => ({
      eventId: `evnt_${index}`,
      eventData: { blob: { data: Array.from({ length: 200_000 }, () => 7), type: "Buffer" } },
    }));

    const started = performance.now();
    writeEventLogCache("run-binary", events, "evnt_39");
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(1_000);
    dropEventLogCache("run-binary");
  });
});

describe("traceEventLogRead", () => {
  it("reports reuse, tail size and duration for one resume", () => {
    const lines: string[] = [];

    traceEventLogRead(RUN, 585, 13, 4.6, (line) => lines.push(line));

    expect(JSON.parse(lines[0]!)).toEqual({
      code: "AGENT_WORKFLOW_EVENT_LOG",
      fetched: 13,
      ms: 5,
      reused: 585,
      runId: RUN,
    });
  });
});
