/**
 * Slow-query trace tests.
 *
 * Constructs covered:
 * - A query over the threshold reports its shape, duration and row count once.
 * - A fast query, and any parameter value, stay out of the log.
 * - Clients checked out of the pool are traced too, and wrapping twice changes nothing.
 */
import { describe, expect, it, vi } from "vitest";

import { traceSlowQueries } from "./pool-trace.js";
import type { Pool } from "pg";

function pool(durations: number[]) {
  let clock = 0;
  const client = {
    query: vi.fn(async () => ({ rows: [{ id: 1 }, { id: 2 }] })),
    release: vi.fn(),
  };
  const base = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => {
      clock += durations.shift() ?? 0;
      return { rows: [{ id: 1 }] };
    }),
  };
  return {
    advance: (ms: number) => {
      clock += ms;
    },
    base,
    client,
    now: () => clock,
  };
}

describe("traceSlowQueries", () => {
  it("reports a slow query without its parameters", async () => {
    const harness = pool([250]);
    const log = vi.fn();
    const traced = traceSlowQueries(harness.base as unknown as Pool, {
      code: "AGENT_DATABASE_SLOW_QUERY",
      log,
      now: harness.now,
      thresholdMs: 150,
    });

    await traced.query(
      "SELECT content FROM memory_items_all WHERE family_id = $1",
      ["family-secret"],
    );

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      code: "AGENT_DATABASE_SLOW_QUERY",
      ms: 250,
      rows: 1,
      statement: "SELECT content FROM memory_items_all WHERE family_id = $1",
    });
    expect(log.mock.calls[0]![0]).not.toContain("family-secret");
  });

  it("stays silent below the threshold", async () => {
    const harness = pool([40]);
    const log = vi.fn();
    const traced = traceSlowQueries(harness.base as unknown as Pool, {
      code: "AGENT_DATABASE_SLOW_QUERY",
      log,
      now: harness.now,
      thresholdMs: 150,
    });

    await traced.query("SELECT 1");

    expect(log).not.toHaveBeenCalled();
  });

  it("traces a client checked out of the pool", async () => {
    const harness = pool([]);
    const log = vi.fn();
    const traced = traceSlowQueries(harness.base as unknown as Pool, {
      code: "AGENT_DATABASE_SLOW_QUERY",
      log,
      now: harness.now,
      thresholdMs: 100,
    });

    harness.client.query.mockImplementation(async () => {
      harness.advance(400);
      return { rows: [{ id: 1 }, { id: 2 }] };
    });
    const client = await traced.connect();
    await client.query("UPDATE memory_items_all SET deleted_at = now()");

    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ ms: 400, rows: 2 });
  });

  it("reports a failing slow query and rethrows it", async () => {
    const harness = pool([]);
    const log = vi.fn();
    harness.base.query.mockImplementation(async () => {
      harness.advance(300);
      throw new Error("deadlock detected");
    });
    const traced = traceSlowQueries(harness.base as unknown as Pool, {
      code: "AGENT_DATABASE_SLOW_QUERY",
      log,
      now: harness.now,
      thresholdMs: 150,
    });

    await expect(traced.query("DELETE FROM memory_items_all")).rejects.toThrow("deadlock detected");
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ ms: 300, rows: null });
  });

  it("wraps a pool once", async () => {
    const harness = pool([250, 250]);
    const log = vi.fn();
    const options = {
      code: "AGENT_DATABASE_SLOW_QUERY",
      log,
      now: harness.now,
      thresholdMs: 150,
    };
    const once = traceSlowQueries(harness.base as unknown as Pool, options);

    expect(traceSlowQueries(once, options)).toBe(once);
    await once.query("SELECT 1");
    expect(log).toHaveBeenCalledTimes(1);
  });
});
