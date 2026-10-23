/**
 * Row-level security by family (migration 171) under the runtime role.
 *
 * Constructs covered:
 * - Every table with family_id has RLS enabled and forced and the family policy; a later migration
 *   that adds such a table without the policy fails here.
 * - Under osinara_app, a family scope sees only its family's rows even in a query without
 *   `WHERE family_id`, cannot write a row of another family, and the system scope sees everything.
 * - `withSystemDatabaseContext` inside a family scope reaches installation-wide rows again.
 */
import { randomBytes } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { APP_DATABASE_ROLE, provisionAppDatabaseRole, requireAppDatabaseConfig } from "../../scripts/app-database-role.ts";
import { closeDatabase, database } from "./database.js";
import { scopeDatabaseContext, withFamilyDatabaseContext, withSystemDatabaseContext } from "./database-context.js";
import { createTwoFamilies, TWO_FAMILIES_TRUNCATE, type TwoFamilies } from "./two-families-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);

(enabled ? describe : describe.skip)("family row-level security", () => {
  let app: pg.Pool;
  let families: TwoFamilies;

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
    app = scopeDatabaseContext(new pg.Pool({ connectionString: appUrl.href, max: 2 }));
  });

  beforeEach(async () => {
    await database().query(TWO_FAMILIES_TRUNCATE);
    families = await createTwoFamilies();
  });

  afterAll(async () => {
    await app?.end();
    await closeDatabase();
  });

  it("puts the family policy on every table with family_id", async () => {
    const { rows } = await database().query<{ table: string }>(`
      SELECT c.relname AS table
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attname = 'family_id' AND NOT a.attisdropped
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (
          SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname
            AND p.policyname = 'osinara_family_scope'))`);
    expect(rows.map((row) => row.table)).toEqual([]);
    const familyTable = await database().query<{ forced: boolean }>(
      "SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = 'families' AND relrowsecurity");
    expect(familyTable.rows[0]?.forced).toBe(true);
    // The memory_items view option is checked by memory-upgrade-ledger.integration.test.ts: migration
    // replays of other files recreate the view in the shared test database.
  });

  it("shows a family scope only its own rows, even without WHERE family_id", async () => {
    const { a, b } = families;
    const all = await withSystemDatabaseContext(() =>
      app.query<{ id: string }>("SELECT id FROM families ORDER BY id"));
    expect(all.rows.map((row) => row.id).sort()).toEqual([a.familyId, b.familyId].sort());

    const seen = await withFamilyDatabaseContext(a.familyId, async () => ({
      families: (await app.query<{ id: string }>("SELECT id FROM families")).rows.map((row) => row.id),
      groups: (await app.query<{ family_id: string }>("SELECT family_id FROM telegram_groups")).rows,
      memberships: (await app.query<{ family_id: string }>("SELECT family_id FROM family_memberships")).rows,
    }));
    expect(seen.families).toEqual([a.familyId]);
    expect(seen.groups.every((row) => row.family_id === a.familyId)).toBe(true);
    expect(seen.memberships.length).toBeGreaterThan(0);
    expect(seen.memberships.every((row) => row.family_id === a.familyId)).toBe(true);
  });

  it("refuses to write another family's row and keeps the system scope reachable inside", async () => {
    const { a, b } = families;
    await withFamilyDatabaseContext(a.familyId, async () => {
      await expect(app.query("UPDATE families SET name = name WHERE id = $1 RETURNING id", [b.familyId]))
        .resolves.toMatchObject({ rowCount: 0 });
      await expect(app.query(
        "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')",
        [b.familyId, a.owner.userId],
      )).rejects.toMatchObject({ code: "42501" });
      const operator = await withSystemDatabaseContext(() =>
        app.query<{ count: string }>("SELECT count(*) FROM families"));
      expect(operator.rows[0]?.count).toBe("2");
    });
  });
});
