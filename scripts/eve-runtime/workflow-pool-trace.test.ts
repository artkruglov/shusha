/**
 * Workflow pool trace tests.
 *
 * Constructs covered:
 * - A slow workflow query reports its shape, duration and row count without parameters.
 * - Fast queries stay silent, checked-out clients are traced, wrapping twice is a no-op.
 */
import { describe, expect, it, vi } from "vitest";

import { traceWorkflowPool } from "./workflow-pool-trace.ts";

function poolStub(delayMs: number) {
  const client = { query: vi.fn(async () => ({ rows: [{ id: 1 }] })) };
  return {
    client,
    pool: {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => {
        const until = performance.now() + delayMs;
        while (performance.now() < until) { /* busy wait keeps the timing real */ }
        return { rows: [{ id: 1 }, { id: 2 }] };
      }),
    },
  };
}

describe("traceWorkflowPool", () => {
  it("reports a slow query without its parameters", async () => {
    const log = vi.fn();
    const stub = poolStub(30);
    const traced = traceWorkflowPool(stub.pool, 10, log);

    await traced.query(
      'select "payload_cbor" from "workflow"."workflow_events" where "run_id" = $1',
      ["wrun_secret"],
    );

    expect(log).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(log.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(entry.code).toBe("AGENT_WORKFLOW_SLOW_QUERY");
    expect(entry.rows).toBe(2);
    expect(entry.statement).toContain("workflow_events");
    expect(log.mock.calls[0]![0]).not.toContain("wrun_secret");
  });

  it("stays silent below the threshold", async () => {
    const log = vi.fn();
    const traced = traceWorkflowPool(poolStub(0).pool, 1000, log);

    await traced.query("select 1");

    expect(log).not.toHaveBeenCalled();
  });

  it("traces a client checked out of the pool and wraps once", async () => {
    const log = vi.fn();
    const stub = poolStub(0);
    stub.client.query.mockImplementation(async () => {
      const until = performance.now() + 30;
      while (performance.now() < until) { /* busy wait keeps the timing real */ }
      return { rows: [{ id: 1 }] };
    });
    const traced = traceWorkflowPool(stub.pool, 10, log);

    expect(traceWorkflowPool(traced, 10, log)).toBe(traced);
    const client = await traced.connect() as { query: (sql: string) => Promise<unknown> };
    await client.query("update workflow.workflow_steps set status = $1");

    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ rows: 1 });
  });
});
