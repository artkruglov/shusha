/**
 * The application role against the migrated Compose test database.
 *
 * Constructs covered:
 * - `provisionAppDatabaseRole` creates the role and, run again, updates its password.
 * - The role reads and changes rows of application tables, and cannot create, alter, drop or
 *   truncate them, nor touch the migration ledger.
 */
import { randomBytes } from "node:crypto";

import pg from "pg";
import { describe, expect, it } from "vitest";

import { APP_DATABASE_ROLE, provisionAppDatabaseRole, requireAppDatabaseConfig } from "./app-database-role.ts";

describe.skipIf(process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true" || !process.env.DATABASE_URL)("app database role", () => {
  it("can change rows and nothing else", async () => {
    const adminUrl = process.env.DATABASE_URL as string;
    const appUrl = new URL(adminUrl);
    appUrl.username = APP_DATABASE_ROLE;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      appUrl.password = randomBytes(24).toString("base64url");
      await provisionAppDatabaseRole(admin, requireAppDatabaseConfig(adminUrl, appUrl.href));
      // A second run is the next release: the password is reconciled, the grants re-applied.
      appUrl.password = randomBytes(24).toString("base64url");
      await provisionAppDatabaseRole(admin, requireAppDatabaseConfig(adminUrl, appUrl.href));
    } finally {
      await admin.end();
    }

    const app = new pg.Client({ connectionString: appUrl.href });
    await app.connect();
    try {
      await expect(app.query("SELECT count(*) FROM users")).resolves.toBeDefined();
      await app.query("BEGIN");
      await expect(app.query("UPDATE users SET id = id WHERE false")).resolves.toBeDefined();
      await expect(app.query("DELETE FROM families WHERE false")).resolves.toBeDefined();
      await app.query("ROLLBACK");

      for (const statement of [
        "CREATE TABLE app_role_probe (id int)",
        "ALTER TABLE users ADD COLUMN app_role_probe int",
        "DROP TABLE users",
        "TRUNCATE families",
        "SELECT count(*) FROM schema_migrations",
        "INSERT INTO schema_migrations (name) VALUES ('999_app_role_probe.sql')",
      ]) {
        await expect(app.query(statement), statement).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await app.end();
    }
  });
});
