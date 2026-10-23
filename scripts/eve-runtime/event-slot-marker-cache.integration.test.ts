/**
 * A run's slot marker is read from the database once per process, not once per event.
 *
 * Constructs covered:
 * - After a run is created (its marker inserted), appending events reads `workflow_event_slots`
 *   no more; before this change every event cost one such SELECT (load run, 3 October 2026:
 *   ~10 reads a turn, the fifth most time of all Workflow statements).
 * - A run created by another process is still recognised: the first read finds the marker and
 *   later events of that run skip it too.
 * - A legacy run without a marker keeps minting ULIDs and is re-checked each time, since the
 *   marker could still appear.
 */
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";

import { createClient } from "../../node_modules/@workflow/world-postgres/dist/drizzle/index.js";
import { createEventsStorage } from "../../node_modules/@workflow/world-postgres/dist/storage.js";

const SLOT_MARKER_READ = /from "workflow"\."workflow_event_slots"/u;
const bytes = (text: string) => new Uint8Array(Buffer.from(text));
const sqlOf = (config: unknown) => typeof config === "string" ? config : (config as { text?: string }).text ?? "";

describe.skipIf(process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true" || !process.env.WORKFLOW_POSTGRES_URL)("event slot marker cache", () => {
  it("reads a run's slot marker once and skips it for every later event", async () => {
    const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 2 });
    const query = vi.spyOn(pool, "query");
    const events = createEventsStorage(createClient(pool));
    const runId = `wrun_${ulid()}`;
    const markerReads = () => query.mock.calls.filter(([config]) => SLOT_MARKER_READ.test(sqlOf(config))).length;
    try {
      await events.create(runId, { eventData: { deploymentId: "cache-test", input: bytes("in"), workflowName: "cache-test" }, eventType: "run_created" } as never);
      await events.create(runId, { eventType: "run_started" } as never);
      for (let i = 0; i < 3; i += 1) {
        const stepId = `step_${randomUUID()}`;
        await events.create(runId, { correlationId: stepId, eventData: { input: bytes("i"), stepName: "s" }, eventType: "step_created" } as never);
        await events.create(runId, { correlationId: stepId, eventData: { stepName: "s" }, eventType: "step_started" } as never);
        await events.create(runId, { correlationId: stepId, eventData: { result: bytes("o"), stepName: "s" }, eventType: "step_completed" } as never);
      }
      expect(markerReads()).toBe(0);
      const ids = await pool.query<{ id: string }>("SELECT id FROM workflow.workflow_events WHERE run_id = $1 ORDER BY id", [runId]);
      expect(ids.rows.every((row) => row.id.startsWith("evnt_"))).toBe(true);
      expect(ids.rows).toHaveLength(11);

      // Another process created this run: one read finds the marker, the rest of the run skips it.
      const foreign = `wrun_${ulid()}`;
      await pool.query("INSERT INTO workflow.workflow_runs (id, deployment_id, status, name, spec_version) VALUES ($1, 'postgres', 'running', 'cache-test', 6)", [foreign]);
      await pool.query("INSERT INTO workflow.workflow_event_slots (run_id) VALUES ($1)", [foreign]);
      await pool.query("INSERT INTO workflow.workflow_events (id, type, run_id) VALUES ('evnt_00000000000000000000000001', 'run_created', $1)", [foreign]);
      const before = markerReads();
      for (let i = 0; i < 2; i += 1) {
        await events.create(foreign, { correlationId: `step_${randomUUID()}`, eventData: { input: bytes("i"), stepName: "s" }, eventType: "step_created" } as never);
      }
      expect(markerReads() - before).toBe(1);

      // A legacy run has no marker; it is re-checked on every event and keeps the old prefix.
      const legacy = `wrun_${ulid()}`;
      await pool.query("INSERT INTO workflow.workflow_runs (id, deployment_id, status, name, spec_version) VALUES ($1, 'postgres', 'running', 'cache-test', 6)", [legacy]);
      await pool.query("INSERT INTO workflow.workflow_events (id, type, run_id) VALUES ($1, 'run_created', $2)", [`wevt_${ulid()}`, legacy]);
      const beforeLegacy = markerReads();
      for (let i = 0; i < 2; i += 1) {
        await events.create(legacy, { correlationId: `step_${randomUUID()}`, eventData: { input: bytes("i"), stepName: "s" }, eventType: "step_created" } as never);
      }
      expect(markerReads() - beforeLegacy).toBe(2);
      const legacyIds = await pool.query<{ id: string }>("SELECT id FROM workflow.workflow_events WHERE run_id = $1", [legacy]);
      expect(legacyIds.rows.every((row) => row.id.startsWith("wevt_"))).toBe(true);
    } finally {
      for (const id of [runId]) {
        await pool.query("DELETE FROM workflow.workflow_events WHERE run_id = $1", [id]);
        await pool.query("DELETE FROM workflow.workflow_steps WHERE run_id = $1", [id]);
      }
      await pool.query("DELETE FROM workflow.workflow_events WHERE run_id IN (SELECT id FROM workflow.workflow_runs WHERE name = 'cache-test')");
      await pool.query("DELETE FROM workflow.workflow_steps WHERE run_id IN (SELECT id FROM workflow.workflow_runs WHERE name = 'cache-test')");
      await pool.query("DELETE FROM workflow.workflow_event_slots WHERE run_id IN (SELECT id FROM workflow.workflow_runs WHERE name = 'cache-test')");
      await pool.query("DELETE FROM workflow.workflow_runs WHERE name = 'cache-test'");
      await pool.end();
    }
  });
});
