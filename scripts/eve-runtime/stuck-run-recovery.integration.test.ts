/** Stuck Workflow run detection against the real workflow schema in the Compose test database. */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { findInFlightRuns, findStuckRuns, releaseDeadWorkerLocks, requeueInFlightRuns } from "./stuck-run-recovery.ts";

const LIMITS = { retryAfterMs: 10 * 60 * 1000, stepStartedAfterMs: 40 * 60 * 1000 };

describe.skipIf(process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true" || !process.env.WORKFLOW_POSTGRES_URL)("stuck run recovery", () => {
  // 1 October 2026: the turn run's last event was a retry from 20:32, no job existed for it, and
  // the private chat stayed silent until a restart re-enqueued every active run.
  it("finds runs whose retry or step start was never followed up, and nothing else", async () => {
    if (!process.env.WORKFLOW_POSTGRES_URL) throw new Error("TEST_WORKFLOW_DATABASE_MISSING");
    const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 2 });
    const prefix = `stuck-${randomUUID().slice(0, 8)}`;
    const runs = {
      freshRetry: { last: "step_retrying", minutesAgo: 2, status: "running" },
      lostRetry: { last: "step_retrying", minutesAgo: 30, status: "running" },
      lostStart: { last: "step_started", minutesAgo: 45, status: "running" },
      longStart: { last: "step_started", minutesAgo: 30, status: "running" },
      parked: { last: "hook_created", minutesAgo: 600, status: "running" },
      finished: { last: "step_retrying", minutesAgo: 30, status: "completed" },
    } as const;
    try {
      for (const [name, run] of Object.entries(runs)) {
        const runId = `${prefix}-${name}`;
        await pool.query(
          "INSERT INTO workflow.workflow_runs (id, deployment_id, status, name) VALUES ($1, 'postgres', $2, 'workflow//eve//turnWorkflow')",
          [runId, run.status],
        );
        await pool.query(
          `INSERT INTO workflow.workflow_events (id, type, run_id, created_at)
           VALUES ($1, 'run_created', $2, LOCALTIMESTAMP - make_interval(mins => $3::int + 1)),
                  ($4, $5, $2, LOCALTIMESTAMP - make_interval(mins => $3::int))`,
          [`${runId}-a`, runId, run.minutesAgo, `${runId}-b`, run.last],
        );
      }

      const found = (await findStuckRuns(pool, LIMITS)).filter((run) => run.runId.startsWith(prefix));
      expect(found.map((run) => run.runId.slice(prefix.length + 1)).sort()).toEqual(["lostRetry", "lostStart"]);
      expect(found.every((run) => run.workflowName === "workflow//eve//turnWorkflow")).toBe(true);
    } finally {
      await pool.query("DELETE FROM workflow.workflow_events WHERE run_id LIKE $1", [`${prefix}-%`]);
      await pool.query("DELETE FROM workflow.workflow_runs WHERE id LIKE $1", [`${prefix}-%`]);
      await pool.end();
    }
  }, 15_000);

  // Startup used to re-enqueue every active run, so each parked session replayed its whole log on
  // every deploy (ilkruglov 7afdc12: 79 runs on one installation); only interrupted runs need that.
  it("names the runs interrupted mid-flight and leaves parked sessions and sleeps alone", async () => {
    if (!process.env.WORKFLOW_POSTGRES_URL) throw new Error("TEST_WORKFLOW_DATABASE_MISSING");
    const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 2 });
    const prefix = `inflight-${randomUUID().slice(0, 8)}`;
    const runs = {
      justStarted: { last: "step_started", minutesAgo: 0, status: "running" },
      betweenSteps: { last: "step_completed", minutesAgo: 1, status: "running" },
      retrying: { last: "step_retrying", minutesAgo: 1, status: "pending" },
      hookArrived: { last: "hook_received", minutesAgo: 1, status: "running" },
      created: { last: "run_created", minutesAgo: 1, status: "pending" },
      parked: { last: "hook_created", minutesAgo: 1, status: "running" },
      sleeping: { last: "wait_created", minutesAgo: 1, status: "running" },
      // An active session waits on a hook created turns ago, so its last event is the completed
      // turn step (ilkruglov 583c5ef: nine such runs replayed on every start).
      restingOnHook: { last: "step_completed", minutesAgo: 30, status: "running", hook: true },
      // The same without a hook has nothing to wake it: interrupted, however old.
      abandoned: { last: "step_completed", minutesAgo: 30, status: "running" },
      finished: { last: "step_completed", minutesAgo: 1, status: "completed" },
    } as const;
    const interrupted = ["abandoned", "betweenSteps", "created", "hookArrived", "justStarted", "retrying"];
    try {
      for (const [name, run] of Object.entries(runs)) {
        const runId = `${prefix}-${name}`;
        await pool.query(
          "INSERT INTO workflow.workflow_runs (id, deployment_id, status, name) VALUES ($1, 'postgres', $2, 'workflow//eve//turnWorkflow')",
          [runId, run.status],
        );
        await pool.query(
          `INSERT INTO workflow.workflow_events (id, type, run_id, created_at)
           VALUES ($1, 'run_created', $2, LOCALTIMESTAMP - make_interval(mins => $3::int + 1)),
                  ($4, $5, $2, LOCALTIMESTAMP - make_interval(mins => $3::int))`,
          [`${runId}-a`, runId, run.minutesAgo, `${runId}-b`, run.last],
        );
        if ("hook" in run && run.hook) {
          await pool.query(
            "INSERT INTO workflow.workflow_hooks (run_id, hook_id, token, owner_id, project_id, environment) VALUES ($1, $2, $3, 'o', 'p', 'e')",
            [runId, `${runId}-hook`, `${runId}-token`],
          );
        }
      }

      // A page of three forces the id-keyed paging through several rounds.
      const found = (await findInFlightRuns(pool, 3)).filter((run) => run.runId.startsWith(prefix));
      expect(found.map((run) => run.runId.slice(prefix.length + 1)).sort()).toEqual(interrupted);
      const enqueued: string[] = [];
      await requeueInFlightRuns({
        enqueue: async (queueName, message) => { enqueued.push(`${queueName}|${message.runId}`); },
        pool,
        queuePrefix: "test//",
      });
      expect(enqueued.filter((entry) => entry.includes(prefix)).sort())
        .toEqual(interrupted.map((name) => `test//workflow//eve//turnWorkflow|${prefix}-${name}`));
    } finally {
      await pool.query("DELETE FROM workflow.workflow_hooks WHERE run_id LIKE $1", [`${prefix}-%`]);
      await pool.query("DELETE FROM workflow.workflow_events WHERE run_id LIKE $1", [`${prefix}-%`]);
      await pool.query("DELETE FROM workflow.workflow_runs WHERE id LIKE $1", [`${prefix}-%`]);
      await pool.end();
    }
  }, 15_000);

  it("frees jobs locked by a worker that died before this process started, and only those", async () => {
    if (!process.env.WORKFLOW_POSTGRES_URL) throw new Error("TEST_WORKFLOW_DATABASE_MISSING");
    const pool = new Pool({ connectionString: process.env.WORKFLOW_POSTGRES_URL, max: 2 });
    const marker = `osinara-test-${randomUUID()}`;
    try {
      const dead = await pool.query<{ id: string }>("SELECT (graphile_worker.add_job($1, '{}'::json)).id::text AS id", [marker]);
      const live = await pool.query<{ id: string }>("SELECT (graphile_worker.add_job($1, '{}'::json)).id::text AS id", [marker]);
      await pool.query("UPDATE graphile_worker._private_jobs SET locked_by = 'worker-dead', locked_at = now() - interval '10 minutes' WHERE id = $1::bigint", [dead.rows[0]!.id]);
      await pool.query("UPDATE graphile_worker._private_jobs SET locked_by = 'worker-live', locked_at = now() WHERE id = $1::bigint", [live.rows[0]!.id]);

      await releaseDeadWorkerLocks(pool, new Date(Date.now() - 60_000));
      const rows = await pool.query<{ id: string; locked_by: string | null }>(
        "SELECT id::text, locked_by FROM graphile_worker._private_jobs WHERE id = ANY($1::bigint[]) ORDER BY id",
        [[dead.rows[0]!.id, live.rows[0]!.id]],
      );
      expect(rows.rows).toEqual([
        { id: dead.rows[0]!.id, locked_by: null },
        { id: live.rows[0]!.id, locked_by: "worker-live" },
      ]);
    } finally {
      await pool.query("DELETE FROM graphile_worker._private_jobs WHERE task_id IN (SELECT id FROM graphile_worker._private_tasks WHERE identifier = $1)", [marker]);
      await pool.end();
    }
  });
});
