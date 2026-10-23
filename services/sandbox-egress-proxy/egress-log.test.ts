/**
 * Egress log tests.
 *
 * Constructs covered:
 * - One `AGENT_SANDBOX_EGRESS` line per connection with client, destination, bytes and duration.
 * - The line is written once however many ends a connection reports.
 * - A counter attached together with its pipe does not take bytes away from the pipe.
 * - The daily budget adds up a client's connections as bytes flow, stops the one that crosses it,
 *   refuses new ones until the next UTC day and leaves other clients alone.
 */
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createEgressBudget, createEgressMeter, egressDailyBytesFromEnv } from "./egress-log.js";

describe("createEgressMeter", () => {
  it("logs one line with the bytes each way and the client address", async () => {
    const lines: string[] = [];
    let clock = 1_000;
    const meter = createEgressMeter({
      client: "::ffff:172.30.0.7",
      host: "example.com",
      kind: "connect",
      log: (line) => lines.push(line),
      now: () => clock,
      port: 443,
    });
    const fromClient = new PassThrough();
    const fromUpstream = new PassThrough();
    const sink = new PassThrough();
    const received: Buffer[] = [];
    sink.on("data", (chunk: Buffer) => received.push(chunk));

    meter.countOut(fromClient, 5);
    fromClient.pipe(sink);
    meter.countIn(fromUpstream);
    fromUpstream.resume();
    fromClient.end("hello world");
    fromUpstream.end(Buffer.alloc(300));
    await new Promise((resolve) => setImmediate(resolve));
    clock = 1_250;
    meter.finish({ status: 200 });
    meter.finish({ status: 200 });

    expect(Buffer.concat(received).toString()).toBe("hello world");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      bytesIn: 300,
      bytesOut: 16,
      client: "172.30.0.7",
      code: "AGENT_SANDBOX_EGRESS",
      durationMs: 250,
      host: "example.com",
      kind: "connect",
      port: 443,
      status: 200,
    });
  });

  it("adds up a client's connections against one daily budget and stops the one that crosses it", async () => {
    const lines: string[] = [];
    let clock = Date.UTC(2026, 9, 8, 23, 0);
    const budget = createEgressBudget({ dailyBytes: 1_000, log: (line) => lines.push(line), now: () => clock });
    const meter = (client: string, onOverBudget: () => void) => createEgressMeter({
      budget, client, host: "example.com", kind: "connect", log: () => undefined, onOverBudget, port: 443,
    });
    const stopped: string[] = [];
    const first = new PassThrough();
    const second = new PassThrough();
    const neighbour = new PassThrough();
    meter("::ffff:172.30.0.7", () => stopped.push("first")).countIn(first);
    meter("172.30.0.7", () => stopped.push("second")).countOut(second);
    meter("172.30.0.8", () => stopped.push("neighbour")).countIn(neighbour);
    first.resume();
    second.resume();
    neighbour.resume();

    first.write(Buffer.alloc(600));
    neighbour.write(Buffer.alloc(900));
    second.write(Buffer.alloc(500));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopped).toEqual(["second"]);
    expect(budget.admit("172.30.0.7")).toBe(false);
    expect(budget.admit("::ffff:172.30.0.8")).toBe(true);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { client: "172.30.0.7", code: "AGENT_SANDBOX_EGRESS_DAILY_LIMIT", dailyBytes: 1_000 },
      { client: "172.30.0.7", code: "AGENT_SANDBOX_EGRESS_DAILY_LIMIT", dailyBytes: 1_000 },
    ]);

    clock = Date.UTC(2026, 9, 9, 0, 1);
    expect(budget.admit("172.30.0.7")).toBe(true);
  });

  it("reads the daily budget from the environment and rejects a malformed one", () => {
    expect(egressDailyBytesFromEnv({})).toBe(2 * 1024 ** 3);
    expect(egressDailyBytesFromEnv({ SANDBOX_EGRESS_DAILY_BYTES: "1048576" })).toBe(1_048_576);
    expect(() => egressDailyBytesFromEnv({ SANDBOX_EGRESS_DAILY_BYTES: "2GB" })).toThrow("AGENT_SANDBOX_EGRESS_CONFIG_INVALID");
    expect(() => egressDailyBytesFromEnv({ SANDBOX_EGRESS_DAILY_BYTES: "0" })).toThrow("AGENT_SANDBOX_EGRESS_CONFIG_INVALID");
  });
});
