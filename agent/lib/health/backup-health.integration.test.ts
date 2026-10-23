/**
 * The digest reads what backup.py writes into backup_runs.
 *
 * Constructs covered:
 * - Rows in the exact shape of `record_run_sql` in scripts/family-deploy/backup.py are read back,
 *   under the runtime role `osinara_app`, as the latest run and the latest successful run.
 * - A run that no store accepted does not count as success; an empty table reads as no data.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { APP_DATABASE_ROLE, provisionAppDatabaseRole, requireAppDatabaseConfig } from "../../../scripts/app-database-role.ts";
import { closeDatabase, database } from "../database.js";
import { readBackupHealth } from "./backup-health.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

(enabled ? describe : describe.skip)("backup health", () => {
  let app: pg.Pool;

  beforeAll(async () => {
    const adminUrl = process.env.DATABASE_URL as string;
    const appUrl = new URL(adminUrl);
    appUrl.username = APP_DATABASE_ROLE;
    appUrl.password = randomBytes(24).toString("base64url");
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await provisionAppDatabaseRole(admin, requireAppDatabaseConfig(adminUrl, appUrl.href));
    } finally {
      await admin.end();
    }
    app = new pg.Pool({ connectionString: appUrl.href, max: 1 });
  });
  beforeEach(async () => {
    await database().query("TRUNCATE backup_runs");
  });
  afterAll(async () => {
    await app?.end();
    await closeDatabase();
  });

  it("reads nothing from an empty table", async () => {
    expect(await readBackupHealth(app)).toEqual({ latest: null, latestSuccessAt: null });
  });

  it("returns the latest run and the latest run any store accepted", async () => {
    await database().query(`INSERT INTO backup_runs (created_at, archive_key, archive_bytes, stores_ok, stores_failed)
      VALUES (now() - interval '2 days', 'daily/a.tar.gz.age', 100, ARRAY['yandex','tigris']::text[], ARRAY[]::text[])`);
    const success = await database().query<{ created_at: Date }>(`INSERT INTO backup_runs (created_at, archive_key, archive_bytes, stores_ok, stores_failed)
      VALUES (now() - interval '1 day', 'daily/b.tar.gz.age', 200, ARRAY['tigris']::text[], ARRAY['yandex']::text[]) RETURNING created_at`);
    // The shape backup.py sends through psql: no explicit created_at, empty stores_ok.
    await database().query(`INSERT INTO backup_runs (archive_key, archive_bytes, stores_ok, stores_failed)
      VALUES ('daily/c.tar.gz.age', 300, ARRAY[]::text[], ARRAY['yandex','tigris']::text[])`);

    const health = await readBackupHealth(app);
    expect(health.latest).toMatchObject({ bytes: 300, failed: ["yandex", "tigris"], stored: [] });
    expect(health.latestSuccessAt?.getTime()).toBe(success.rows[0]!.created_at.getTime());
  });
});
