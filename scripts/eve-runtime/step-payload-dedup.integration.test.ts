/**
 * A step's input and output live in the event log only; the step row carries state, not payload.
 *
 * Constructs covered:
 * - step_created, a lazy step_started and step_completed leave `input_cbor`/`output_cbor` of
 *   `workflow_steps` empty while the events keep the bytes.
 * - `steps.get` and `steps.list` still return the input and output, read back from the events.
 * - A step row written before the change (payload in the columns) is returned as before.
 *
 * Load run of 3 October 2026: the same bytes were stored twice (events 1.6 GB, steps 1.0 GB of a
 * 2.9 GB database); replay reads results from step_completed events, nothing reads the columns.
 */
import { randomUUID } from "node:crypto";

import { encode as cborEncode } from "cbor-x";


import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { createClient } from "../../node_modules/@workflow/world-postgres/dist/drizzle/index.js";
import { createEventsStorage, createStepsStorage } from "../../node_modules/@workflow/world-postgres/dist/storage.js";

const bytes = (text: string) => new Uint8Array(Buffer.from(text));
const text = (value: unknown) => Buffer.from(value as Uint8Array).toString();

describe.skipIf(process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true" || !process.env.WORKFLOW_POSTGRES_URL)("step payload storage", () => {
  it("keeps step input and output in the events and serves them from there", async () => {
    const flag = process.env.OSINARA_WORKFLOW_PAYLOAD_BLOBS;
    process.env.OSINARA_WORKFLOW_PAYLOAD_BLOBS = "1";
    const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 2 });
    const drizzle = createClient(pool);
    const events = createEventsStorage(drizzle);
    const steps = createStepsStorage(drizzle);
    const runId = `wrun_${ulid()}`;
    const eager = `step_${randomUUID()}`, lazy = `step_${randomUUID()}`;
    try {
      await events.create(runId, { eventData: { deploymentId: "dedup-test", input: bytes("run input"), workflowName: "dedup-test" }, eventType: "run_created" } as never);
      await events.create(runId, { eventType: "run_started" } as never);
      // The eager path: step_created with the input, then step_started, then step_completed.
      await events.create(runId, { correlationId: eager, eventData: { input: bytes("eager input"), stepName: "eagerStep" }, eventType: "step_created" } as never);
      await events.create(runId, { correlationId: eager, eventData: { stepName: "eagerStep" }, eventType: "step_started" } as never);
      await events.create(runId, { correlationId: eager, eventData: { result: bytes("eager output"), stepName: "eagerStep" }, eventType: "step_completed" } as never);
      // The lazy path: one step_started creates the step and carries its input.
      await events.create(runId, { correlationId: lazy, eventData: { input: bytes("lazy input"), stepName: "lazyStep", workflowName: "dedup-test" }, eventType: "step_started" } as never);
      await events.create(runId, { correlationId: lazy, eventData: { result: bytes("lazy output"), stepName: "lazyStep" }, eventType: "step_completed" } as never);

      const columns = await pool.query<{ step_id: string; input_cbor: Buffer | null; output_cbor: Buffer | null; status: string }>(
        "SELECT step_id, input_cbor, output_cbor, status FROM workflow.workflow_steps WHERE run_id = $1 ORDER BY step_id",
        [runId],
      );
      expect(columns.rows.map((row) => [row.status, row.input_cbor, row.output_cbor])).toEqual([
        ["completed", null, null], ["completed", null, null],
      ]);
      const stored = await pool.query<{ type: string; n: string }>(
        "SELECT type, count(*)::text AS n FROM workflow.workflow_events WHERE run_id = $1 AND payload_cbor IS NOT NULL GROUP BY type",
        [runId],
      );
      expect(Object.fromEntries(stored.rows.map((row) => [row.type, Number(row.n)]))).toMatchObject({ step_completed: 2, step_created: 2 });

      const eagerStep = await steps.get(runId, eager);
      expect([text(eagerStep.input), text(eagerStep.output), eagerStep.status]).toEqual(["eager input", "eager output", "completed"]);
      const lazyStep = await steps.get(runId, lazy);
      expect([text(lazyStep.input), text(lazyStep.output)]).toEqual(["lazy input", "lazy output"]);
      const listed = await steps.list({ runId } as never);
      const byStepId = (a: string[], b: string[]) => a[0]!.localeCompare(b[0]!);
      expect(listed.data.map((step: { stepId: string; input?: unknown; output?: unknown }) => [step.stepId, text(step.input), text(step.output)]).sort(byStepId))
        .toEqual([[eager, "eager input", "eager output"], [lazy, "lazy input", "lazy output"]].sort(byStepId));
      // Without the payload nothing is read from the events.
      const bare = await steps.get(runId, eager, { resolveData: "none" } as never);
      expect([bare.input, bare.output]).toEqual([undefined, undefined]);

      // A row from before the change still answers from its own columns.
      await pool.query(
        "UPDATE workflow.workflow_steps SET input_cbor = $2, output_cbor = $3 WHERE step_id = $1",
        [eager, Buffer.from(encodeCbor(bytes("column input"))), Buffer.from(encodeCbor(bytes("column output")))],
      );
      const legacy = await steps.get(runId, eager);
      expect([text(legacy.input), text(legacy.output)]).toEqual(["column input", "column output"]);

      // Until the flag is on, the row columns are still written (double write), so a rollback to
      // the previous release finds them; the readers prefer the events either way.
      delete process.env.OSINARA_WORKFLOW_PAYLOAD_BLOBS;
      const dual = `step_${randomUUID()}`;
      await events.create(runId, { correlationId: dual, eventData: { input: bytes("dual input"), stepName: "dualStep" }, eventType: "step_created" } as never);
      await events.create(runId, { correlationId: dual, eventData: { stepName: "dualStep" }, eventType: "step_started" } as never);
      await events.create(runId, { correlationId: dual, eventData: { result: bytes("dual output"), stepName: "dualStep" }, eventType: "step_completed" } as never);
      const dualRow = await pool.query<{ input_cbor: Buffer | null; output_cbor: Buffer | null; status: string }>(
        "SELECT input_cbor, output_cbor, status FROM workflow.workflow_steps WHERE run_id = $1 AND step_id = $2",
        [runId, dual],
      );
      expect(dualRow.rows[0]!.status).toBe("completed");
      expect(dualRow.rows[0]!.input_cbor).not.toBeNull();
      expect(dualRow.rows[0]!.output_cbor).not.toBeNull();
      const dualStep = await steps.get(runId, dual);
      expect([text(dualStep.input), text(dualStep.output)]).toEqual(["dual input", "dual output"]);
    } finally {
      if (flag === undefined) delete process.env.OSINARA_WORKFLOW_PAYLOAD_BLOBS;
      else process.env.OSINARA_WORKFLOW_PAYLOAD_BLOBS = flag;
      await pool.query("DELETE FROM workflow.workflow_events WHERE run_id = $1", [runId]);
      await pool.query("DELETE FROM workflow.workflow_steps WHERE run_id = $1", [runId]);
      await pool.query("DELETE FROM workflow.workflow_event_slots WHERE run_id = $1", [runId]);
      await pool.query("DELETE FROM workflow.workflow_runs WHERE id = $1", [runId]);
      await pool.end();
    }
  });
});

/** The column's own encoding (drizzle `Cbor()` type), for a row written by the previous storage. */
function encodeCbor(value: Uint8Array): Uint8Array {
  return cborEncode(value);
}
