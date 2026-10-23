/**
 * Personal project twins of a legacy family (migration 178) and the resolver that stops making them.
 *
 * Constructs covered:
 * - A personal project without an area folds into the same author's project in their personal space:
 *   its tasks move with the space, the twin is cancelled, the sphere is kept, a second run changes nothing.
 * - A family project and another person's project of the same name are left alone.
 * - In the legacy mode the resolver finds the old project and the new task takes its space, so no twin
 *   appears again; a task that is visible may be completed there, as a new one may.
 * - `manage_projects merge` folds such a twin by hand the same way.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { findNamedProject } from "./project-resolver.js";
import { projectRepository } from "./project-repository.js";
import { requireTaskRecordAction } from "../spaces/task-space-action.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
const OWNER = "780001";
const SPOUSE = "780002";

async function setup() {
  const db = database();
  const family = (await db.query<{ id: string }>("INSERT INTO families(name) VALUES('Legacy twins') RETURNING id")).rows[0]!.id;
  const ids: Record<string, string> = {};
  for (const [telegram, role] of [[OWNER, "owner"], [SPOUSE, "member"]] as const) {
    const user = (await db.query<{ id: string }>(
      "INSERT INTO users(telegram_user_id,display_name) VALUES($1,$1) RETURNING id", [telegram])).rows[0]!.id;
    await db.query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,$3)", [family, user, role]);
    ids[telegram] = user;
  }
  const space = (await db.query<{ id: string }>(
    `INSERT INTO spaces(family_id,kind,title,owner_user_id,legacy_scope,state)
     VALUES($1,'personal','Личное',$2,'personal','active') RETURNING id`, [family, ids[OWNER]])).rows[0]!.id;
  const project = async (title: string, scope: string, creator: string, spaceId: string | null, lifeArea: string | null = null) =>
    (await db.query<{ id: string }>(
      `INSERT INTO shared_tasks(family_id,scope,creator_telegram_id,assignee_telegram_id,title,status,kind,space_id,life_area,created_at)
       VALUES($1,$2,$3,$3,$4,'accepted','project',$5,$6,now() - interval '1 hour' * $7) RETURNING id`,
      [family, scope, creator, title, spaceId, lifeArea, spaceId ? 48 : 1])).rows[0]!.id;
  const task = async (title: string, projectId: string, spaceId: string | null, scope = "personal", assignee = OWNER) =>
    (await db.query<{ id: string }>(
      `INSERT INTO shared_tasks(family_id,scope,creator_telegram_id,assignee_telegram_id,title,status,kind,space_id,project_id,list_name)
       VALUES($1,$2,$3,$3,$4,'accepted','task',$5,$6,'Т-Банк') RETURNING id`,
      [family, scope, assignee, title, spaceId, projectId])).rows[0]!.id;
  const canon = await project("Т-Банк", "personal", OWNER, space);
  const twin = await project("т-банк", "personal", OWNER, null, "work");
  const familyProject = await project("Т-Банк", "family", OWNER, null);
  const spouseProject = await project("Т-Банк", "personal", SPOUSE, null);
  const oldTask = await task("Встреча с Натальей", canon, space);
  const newTask = await task("Предложение по ИИ", twin, null);
  const familyTask = await task("Общий созвон", familyProject, null, "family");
  return { canon, familyId: family, familyProject, familyTask, newTask, oldTask, space, spouseProject, twin, userId: ids[OWNER]! };
}

async function runMigration() {
  const sql = await readFile(resolve("migrations/178_merge_legacy_personal_project_twins.sql"), "utf8");
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

(enabled ? describe : describe.skip)("legacy personal project twins", () => {
  beforeEach(async () => {
    await database().query("DELETE FROM families WHERE name = 'Legacy twins'");
    await database().query("DELETE FROM users WHERE telegram_user_id IN ($1, $2)", [OWNER, SPOUSE]);
  });
  afterAll(closeDatabase);

  it("folds a personal twin into the author's project in their space and leaves other projects alone", async () => {
    const f = await setup();
    await runMigration();
    const rows = (await database().query<{ id: string; status: string; project_id: string | null; space_id: string | null; life_area: string | null }>(
      "SELECT id, status, project_id, space_id, life_area FROM shared_tasks WHERE family_id=$1", [f.familyId])).rows;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(f.twin)).toMatchObject({ status: "cancelled" });
    expect(byId.get(f.canon)).toMatchObject({ life_area: "work", status: "accepted" });
    expect(byId.get(f.newTask)).toMatchObject({ project_id: f.canon, space_id: f.space });
    expect(byId.get(f.oldTask)).toMatchObject({ project_id: f.canon, space_id: f.space });
    expect(byId.get(f.familyProject)).toMatchObject({ status: "accepted" });
    expect(byId.get(f.spouseProject)).toMatchObject({ status: "accepted" });
    expect(byId.get(f.familyTask)).toMatchObject({ project_id: f.familyProject, space_id: null });
    const versions = await database().query("SELECT 1 FROM shared_task_versions WHERE task_id=$1 AND action='project_merge'", [f.newTask]);
    expect(versions.rowCount).toBe(1);

    await runMigration();
    const again = await database().query("SELECT count(*)::int AS n FROM audit_events WHERE family_id=$1 AND event_type='project.legacy_twin_merged'", [f.familyId]);
    expect(again.rows[0].n).toBe(1);
  });

  it("finds the old project in the legacy mode, so no twin is made again, and lets its task be changed", async () => {
    const f = await setup();
    await runMigration();
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const found = await findNamedProject(client,
        { familyId: f.familyId, groupId: null, ownerTelegramId: OWNER, scope: "personal", spaceId: null }, OWNER, "Т-банк");
      expect(found).toEqual({ created: false, id: f.canon, spaceId: f.space });
      // Another person's list of the same name stays theirs.
      const spouse = await findNamedProject(client,
        { familyId: f.familyId, groupId: null, ownerTelegramId: SPOUSE, scope: "personal", spaceId: null }, SPOUSE, "Т-Банк");
      expect(spouse.id).toBe(f.spouseProject);
      // The legacy mode authorizes a task by identity whatever area it came from.
      await expect(requireTaskRecordAction(client, {
        familyId: f.familyId, groupId: null, role: "owner", scopes: ["personal", "family"], telegramActorId: OWNER,
        telegramActorKind: "telegram_user", telegramUserId: OWNER, userId: f.userId,
      }, f.oldTask, "complete_own_task")).resolves.toBeGreaterThan(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("merges a twin by hand into the author's project with its space", async () => {
    const f = await setup();
    const auth = {
      familyId: f.familyId, groupId: null, role: "owner" as const, scopes: ["personal", "family"] as ("personal" | "family")[],
      telegramActorId: OWNER, telegramActorKind: "telegram_user" as const, telegramUserId: OWNER, userId: f.userId,
    };
    const version = (await database().query<{ version: number }>("SELECT version FROM shared_tasks WHERE id=$1", [f.twin])).rows[0]!.version;
    await projectRepository.execute(auth, { action: "merge", id: f.twin, intoId: f.canon, version } as never);
    const moved = (await database().query("SELECT project_id, space_id FROM shared_tasks WHERE id=$1", [f.newTask])).rows[0];
    expect(moved).toEqual({ project_id: f.canon, space_id: f.space });
  });
});
