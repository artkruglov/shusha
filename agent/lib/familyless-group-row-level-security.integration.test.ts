/**
 * Row-level security of a group without a family (migration 175) under the runtime role.
 *
 * Constructs covered:
 * - Every table whose family_id may be NULL carries the group policy next to the family one; a later
 *   migration that relaxes family_id without it fails here.
 * - The schema admits a group without a family only as an external group with who enabled it and its
 *   budget, and a family group never carries those two.
 * - A group scope sees only its own group's rows, a family scope sees none of them, and neither can
 *   write a row of the other group.
 * - Inserting such a group creates its conversation but no family profile rows; deleting it removes
 *   the conversation and audit and leaves a retired session only to the system scope.
 */
import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { APP_DATABASE_ROLE, provisionAppDatabaseRole, requireAppDatabaseConfig } from "../../scripts/app-database-role.ts";
import { closeDatabase, database } from "./database.js";
import {
  scopeDatabaseContext,
  withFamilyDatabaseContext,
  withGroupDatabaseContext,
  withSystemDatabaseContext,
} from "./database-context.js";
import { createTwoFamilies, TWO_FAMILIES_TRUNCATE, type TwoFamilies } from "./two-families-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);

async function insertFamilylessGroup(chatId: string): Promise<{ groupId: string; conversationId: string }> {
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode, enabled_by_telegram_user_id, monthly_budget_usd)
     VALUES (NULL, $1, 'Соседи', 'external', 'addressed_only', '700100', 5) RETURNING id`,
    [chatId],
  );
  const groupId = group.rows[0]!.id;
  const conversation = await database().query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id = $1", [groupId]);
  return { conversationId: conversation.rows[0]!.id, groupId };
}

async function insertSession(groupId: string): Promise<string> {
  const session = await database().query<{ id: string }>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, group_id, scope, conversation_key, continuation_token,
        started_at, last_activity_at, kind)
     VALUES ($1, 1, NULL, $2, 'group', $3, $4, now(), now(), 'canonical') RETURNING id`,
    [randomUUID(), groupId, `group:${groupId}`, randomUUID()],
  );
  return session.rows[0]!.id;
}

(enabled ? describe : describe.skip)("row-level security of a group without a family", () => {
  let app: pg.Pool;
  let families: TwoFamilies;
  let left: { groupId: string; conversationId: string };
  let right: { groupId: string; conversationId: string };

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
    await database().query(TWO_FAMILIES_TRUNCATE.replace("TRUNCATE", "TRUNCATE audit_events, conversation_participants,"));
    families = await createTwoFamilies();
    left = await insertFamilylessGroup("-100700001");
    right = await insertFamilylessGroup("-100700002");
  });

  afterAll(async () => {
    await app?.end();
    await closeDatabase();
  });

  it("puts the group policy on every table whose family may be absent", async () => {
    const { rows } = await database().query<{ table: string; guarded: boolean }>(`
      SELECT c.relname AS table, c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (
          SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname
            AND p.policyname = 'osinara_group_scope') AS guarded
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attname = 'family_id'
        AND NOT a.attisdropped AND NOT a.attnotnull
      ORDER BY c.relname`);
    expect(rows).toEqual([
      { guarded: true, table: "application_conversations" },
      { guarded: true, table: "audit_events" },
      { guarded: true, table: "conversation_participants" },
      { guarded: true, table: "conversation_sessions" },
      { guarded: true, table: "telegram_groups" },
    ]);
  });

  it("admits a group without a family only as an enabled external group with a budget", async () => {
    const insert = (type: string, enabledBy: string | null, budget: number | null, familyId: string | null = null) =>
      database().query(
        `INSERT INTO telegram_groups
           (family_id, telegram_chat_id, title, type, message_mode, enabled_by_telegram_user_id, monthly_budget_usd)
         VALUES ($1, '-100700009', 'Проба', $2, 'addressed_only', $3, $4)`,
        [familyId, type, enabledBy, budget],
      );
    await expect(insert("family_private", "700100", 5)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("external", null, 5)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("external", "700100", null)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("external", "700100", 0)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("external", "700100", 5, families.a.familyId)).rejects.toMatchObject({ code: "23514" });
  });

  it("hides a group without a family from a family scope, so only the system scope can name the conflict", async () => {
    // A family owner registering this chat from private chat: the repository asks the system scope
    // (`telegram-group-administration-repository.ts`, registrationConflict) because the family scope sees nothing.
    const query = "SELECT family_id IS NULL AS familyless FROM telegram_groups WHERE telegram_chat_id = '-100700001'";
    const fromFamily = await withFamilyDatabaseContext(families.a.familyId, async () => (await app.query(query)).rows);
    const fromSystem = await withSystemDatabaseContext(async () => (await app.query(query)).rows);
    expect(fromFamily).toEqual([]);
    expect(fromSystem).toEqual([{ familyless: true }]);
  });

  it("shows a group scope only its own rows and a family scope none of them", async () => {
    await database().query(
      "INSERT INTO audit_events (family_id, group_id, event_type) VALUES (NULL, $1, 'probe'), (NULL, $2, 'probe')",
      [left.groupId, right.groupId],
    );
    const sessionId = await insertSession(left.groupId);
    const seen = await withGroupDatabaseContext(left.groupId, async () => ({
      audit: (await app.query<{ group_id: string }>("SELECT group_id FROM audit_events")).rows,
      conversations: (await app.query<{ id: string }>("SELECT id FROM application_conversations")).rows,
      families: (await app.query("SELECT id FROM families")).rowCount,
      groups: (await app.query<{ id: string }>("SELECT id FROM telegram_groups")).rows,
      memberships: (await app.query("SELECT 1 FROM family_memberships")).rowCount,
      sessions: (await app.query<{ id: string }>("SELECT id FROM conversation_sessions")).rows,
    }));
    expect(seen).toEqual({
      audit: [{ group_id: left.groupId }],
      conversations: [{ id: left.conversationId }],
      families: 0,
      groups: [{ id: left.groupId }],
      memberships: 0,
      sessions: [{ id: sessionId }],
    });

    const family = await withFamilyDatabaseContext(families.a.familyId, async () => ({
      audit: (await app.query("SELECT 1 FROM audit_events WHERE family_id IS NULL")).rowCount,
      groups: (await app.query("SELECT 1 FROM telegram_groups WHERE family_id IS NULL")).rowCount,
      sessions: (await app.query("SELECT 1 FROM conversation_sessions WHERE family_id IS NULL")).rowCount,
    }));
    expect(family).toEqual({ audit: 0, groups: 0, sessions: 0 });
  });

  it("refuses to write into another group or a family from a group scope", async () => {
    await withGroupDatabaseContext(left.groupId, async () => {
      await expect(app.query(
        "INSERT INTO audit_events (family_id, group_id, event_type) VALUES (NULL, $1, 'probe')", [left.groupId],
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(app.query(
        "INSERT INTO audit_events (family_id, group_id, event_type) VALUES (NULL, $1, 'probe')", [right.groupId],
      )).rejects.toMatchObject({ code: "42501" });
      await expect(app.query(
        "INSERT INTO audit_events (family_id, group_id, event_type) VALUES ($1, NULL, 'probe')", [families.a.familyId],
      )).rejects.toMatchObject({ code: "42501" });
      await expect(app.query("UPDATE telegram_groups SET title = 'чужая' WHERE id = $1", [right.groupId]))
        .resolves.toMatchObject({ rowCount: 0 });
      const operator = await withSystemDatabaseContext(() =>
        app.query<{ count: string }>("SELECT count(*) FROM telegram_groups WHERE family_id IS NULL"));
      expect(operator.rows[0]?.count).toBe("2");
    });
  });

  it("keeps family profile rows out of a group without a family", async () => {
    await withGroupDatabaseContext(left.groupId, () => app.query(
      `INSERT INTO conversation_participants
         (conversation_id, family_id, scope, scope_partition_key, telegram_user_id, first_observed_at, last_observed_at)
       VALUES ($1, NULL, 'group', $2, '700200', now(), now())`,
      [left.conversationId, left.groupId],
    ));
    const counts = await database().query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM profile_subjects WHERE conversation_id = $1) AS subjects,
      (SELECT count(*) FROM external_profile_projection_policies WHERE group_id = $2) AS policies,
      (SELECT count(*) FROM external_profile_projection_notices WHERE group_id = $2) AS notices`,
    [left.conversationId, left.groupId]);
    expect(counts.rows[0]).toEqual({ notices: "0", policies: "0", subjects: "0" });

    // A participant cannot claim the group's conversation under another partition.
    await expect(database().query(
      `INSERT INTO conversation_participants
         (conversation_id, family_id, scope, scope_partition_key, telegram_user_id, first_observed_at, last_observed_at)
       VALUES ($1, NULL, 'group', $2, '700201', now(), now())`,
      [left.conversationId, right.groupId],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("removes the conversation and audit with the group and leaves the retired session to the system", async () => {
    await database().query(
      "INSERT INTO audit_events (family_id, group_id, event_type) VALUES (NULL, $1, 'probe')", [left.groupId]);
    const sessionId = await insertSession(left.groupId);
    await database().query("DELETE FROM telegram_groups WHERE id = $1", [left.groupId]);
    const counts = await database().query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM application_conversations WHERE id = $1) AS conversations,
      (SELECT count(*) FROM audit_events WHERE group_id = $2) AS audit,
      (SELECT count(*) FROM conversation_sessions WHERE id = $3 AND retired_at IS NOT NULL AND group_id IS NULL) AS retired`,
    [left.conversationId, left.groupId, sessionId]);
    expect(counts.rows[0]).toEqual({ audit: "0", conversations: "0", retired: "1" });
    const asGroup = await withGroupDatabaseContext(left.groupId, () =>
      app.query("SELECT 1 FROM conversation_sessions WHERE id = $1", [sessionId]));
    expect(asGroup.rowCount).toBe(0);
  });

  it("rejects a group scope that is not a uuid", () => {
    expect(() => withGroupDatabaseContext("group-1", async () => undefined))
      .toThrow("AGENT_DATABASE_CONTEXT_INVALID");
  });
});
