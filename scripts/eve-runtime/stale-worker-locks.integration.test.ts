/** Real Graphile schema: a startup release frees only the locks older than the process start. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { releaseStaleWorkerLocks } from "./stale-worker-locks.ts";

const suite = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
suite("stale worker lock release", () => {
  it("frees jobs and job queues locked before this process started, and only those", async () => {
    const url = process.env.DATABASE_URL;
    if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
    const { makeWorkerUtils } = await import(pathToFileURL(resolve("node_modules/graphile-worker/dist/index.js")).href);
    const schema = `stale_${crypto.randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: url, max: 2 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const utils = await makeWorkerUtils({ pgPool: pool, schema });
    try {
      await utils.migrate();
      // Jobs on a named queue also take a lock on the queue row, as a turn's serialized chat queue does.
      const dead = await utils.addJob("turn", {}, { queueName: "chat-dead" });
      const live = await utils.addJob("turn", {}, { queueName: "chat-live" });
      await pool.query(`UPDATE "${schema}"._private_jobs SET locked_by = 'worker-dead', locked_at = now() - interval '10 minutes' WHERE id = $1`, [dead.id]);
      await pool.query(`UPDATE "${schema}"._private_job_queues SET locked_by = 'worker-dead', locked_at = now() - interval '10 minutes' WHERE queue_name = 'chat-dead'`);
      await pool.query(`UPDATE "${schema}"._private_jobs SET locked_by = 'worker-live', locked_at = now() WHERE id = $1`, [live.id]);
      await pool.query(`UPDATE "${schema}"._private_job_queues SET locked_by = 'worker-live', locked_at = now() WHERE queue_name = 'chat-live'`);

      await expect(releaseStaleWorkerLocks(pool, new Date(Date.now() - 60_000), schema)).resolves.toBe(1);

      const jobs = await pool.query<{ id: string; locked_by: string | null }>(`SELECT id::text, locked_by FROM "${schema}"._private_jobs ORDER BY id`);
      expect(jobs.rows).toEqual([{ id: String(dead.id), locked_by: null }, { id: String(live.id), locked_by: "worker-live" }]);
      const queues = await pool.query<{ queue_name: string; locked_by: string | null }>(`SELECT queue_name, locked_by FROM "${schema}"._private_job_queues ORDER BY queue_name`);
      expect(queues.rows).toEqual([{ queue_name: "chat-dead", locked_by: null }, { queue_name: "chat-live", locked_by: "worker-live" }]);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      await utils.release();
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
      warn.mockRestore();
    }
  }, 20_000);
});
