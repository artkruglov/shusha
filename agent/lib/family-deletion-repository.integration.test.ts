/**
 * Erasing a member or a family on the real schema.
 *
 * Constructs covered:
 * - A member who leaves loses their membership, personal memory with its thread, personal tasks, plans, private
 *   sessions (queued for Eve's store) and raw updates, and their user row; a family memory they endorsed stays
 *   without the endorsement, a care area they held is open again; their shared task is free again and the family with its owner stays.
 * - The owner cannot leave this way, and only the owner can delete the family.
 * - Deleting the family removes its rows everywhere and its members' user rows.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./memory-embedding-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./memory-embedding-client.js")>(),
  embedMemoryPassages: vi.fn(async () => [[1, ...Array.from({ length: 383 }, () => 0)]]),
}));

import { closeDatabase, database } from "./database.js";
import { familyDeletionRepository } from "./family-deletion-repository.js";
import { createMainAgentMemoryFixture, createMainAgentPrivateMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { memoryRepository } from "./memory-repository.js";
import { sharedTaskRepository } from "./shared-task-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

const count = async (sql: string, values: unknown[]) =>
  Number((await database().query<{ count: string }>(sql, values)).rows[0]!.count);

/** Анна with a personal memory, its thread and a personal task; a second person owns the family. */
async function family() {
  const fixture = await createMainAgentPrivateMemoryFixture();
  await memoryRepository.create(fixture.auth, {
    confirmation: "model_high",
    content: "Анна готовится к марафону",
    explicitSource: { conversationId: fixture.conversationId, subject: { kind: "current_author" }, timelineEntryId: fixture.timelineEntryId },
    kind: "fact",
    operationKey: "deletion-memory",
    scope: "personal",
    sensitivity: "normal",
    source: "eve:deletion",
    thread: { action: "create", purpose: "Подготовка", role: "goal", title: "Марафон" },
  });
  await sharedTaskRepository.execute(fixture.auth, { action: "create", title: "Личное дело Анны" } as never, "deletion-personal");
  const other = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('700999', 'Борис') RETURNING id");
  await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')",
    [fixture.auth.familyId, other.rows[0]!.id]);
  await database().query(
    "INSERT INTO feedback_messages (family_id, telegram_user_id, text) VALUES ($1, '700999', 'Мешает')",
    [fixture.auth.familyId]);
  return { ...fixture, otherId: other.rows[0]!.id };
}

async function session(familyId: string, userId: string, eveSessionId: string) {
  await database().query(
    `INSERT INTO conversation_sessions (family_id, owner_user_id, scope, thread_id, generation, conversation_key,
       continuation_token, eve_session_id, started_at, last_activity_at, kind)
     VALUES ($1, $2, 'personal', gen_random_uuid(), 0, $3, $3, $3, now(), now(), 'canonical')`,
    [familyId, userId, eveSessionId]);
}

async function ingress(chatId: string) {
  const queue = await database().query<{ id: string }>(
    "INSERT INTO telegram_ingress_queues (current_continuation_key) VALUES ($1) RETURNING id", [`${chatId}::`]);
  await database().query(
    `INSERT INTO telegram_ingress_updates (update_id, queue_id, ingress_continuation_key, payload, status, completed_at)
     VALUES (floor(random() * 1e9)::bigint, $1, $2, '{"message":{"text":"личное"}}', 'completed', now())`,
    [queue.rows[0]!.id, `${chatId}::`]);
}

(enabled ? describe : describe.skip)("family deletion", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families, erased_eve_sessions, telegram_ingress_queues CASCADE");
  });
  afterAll(closeDatabase);

  it("erases a member who leaves and keeps the family", async () => {
    const fixture = await family();
    // Борис becomes the owner, Анна a member; a family task given to Анна must come back free.
    await database().query("UPDATE family_memberships SET role = 'member' WHERE user_id = $1", [fixture.userId]);
    await database().query("UPDATE family_memberships SET role = 'owner' WHERE user_id = $1", [fixture.otherId]);
    const shared = (await database().query<{ id: string }>(
      `INSERT INTO shared_tasks (family_id, scope, kind, title, status, creator_telegram_id, assignee_telegram_id)
       VALUES ($1, 'family', 'task', 'Общее дело', 'accepted', '700999', 'private-memory-author') RETURNING id`,
      [fixture.auth.familyId])).rows[0]!;

    await database().query("INSERT INTO shared_task_plans (task_id, telegram_user_id, planned_from, planned_until) VALUES ($1, 'private-memory-author', '2026-10-20', '2026-10-21')",
      [shared.id]);
    const area = (await database().query<{ id: string }>(
      `INSERT INTO care_areas (family_id, scope, title, details, creator_telegram_id, owner_telegram_id, status, accepted_at)
       VALUES ($1, 'family', 'Врачи', 'Записи к врачам', '700999', 'private-memory-author', 'accepted', now()) RETURNING id`,
      [fixture.auth.familyId])).rows[0]!;
    await session(fixture.auth.familyId, fixture.userId, "wrun_anna_private");
    await ingress("private-memory-author");

    await familyDeletionRepository.deleteMember({ familyId: fixture.auth.familyId, userId: fixture.userId });

    expect(await count("SELECT count(*) FROM shared_task_plans", [])).toBe(0);
    expect((await database().query("SELECT status, owner_telegram_id FROM care_areas WHERE id = $1", [area.id])).rows[0])
      .toEqual({ owner_telegram_id: null, status: "open" });
    expect(await count("SELECT count(*) FROM conversation_sessions WHERE eve_session_id = 'wrun_anna_private'", [])).toBe(0);
    expect(await count("SELECT count(*) FROM erased_eve_sessions WHERE eve_session_id = 'wrun_anna_private'", [])).toBe(1);
    expect(await count("SELECT count(*) FROM telegram_ingress_updates WHERE ingress_continuation_key LIKE 'private-memory-author:%'", [])).toBe(0);

    expect(await count("SELECT count(*) FROM users WHERE id = $1", [fixture.userId])).toBe(0);
    expect(await count("SELECT count(*) FROM memory_items_all WHERE owner_user_id = $1 OR family_id = $2 AND scope = 'personal'",
      [fixture.userId, fixture.auth.familyId])).toBe(0);
    expect(await count("SELECT count(*) FROM memory_threads WHERE family_id = $1 AND scope = 'personal'", [fixture.auth.familyId])).toBe(0);
    expect(await count("SELECT count(*) FROM shared_tasks WHERE title = 'Личное дело Анны'", [])).toBe(0);
    const task = await database().query<{ assignee: string | null; status: string; version: number }>(
      "SELECT status, version, assignee_telegram_id AS assignee FROM shared_tasks WHERE id = $1", [shared.id]);
    expect(task.rows[0]).toEqual({ assignee: null, status: "open", version: 2 });
    expect(await count("SELECT count(*) FROM family_memberships WHERE family_id = $1", [fixture.auth.familyId])).toBe(1);
  });

  it("keeps a family memory the member saved, without their endorsement", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryRepository.create(fixture.auth, {
      confirmation: "model_high",
      content: "Анна готовится к марафону",
      explicitSource: { conversationId: fixture.conversationId, subject: { kind: "current_author" }, timelineEntryId: fixture.timelineEntryId },
      kind: "fact",
      operationKey: "deletion-family-memory",
      scope: "family",
      sensitivity: "normal",
      source: "eve:deletion",
    });
    await database().query("UPDATE memory_items_all SET endorsed_by_user_id = $1, endorsed_at = now() WHERE family_id = $2",
      [fixture.userId, fixture.familyId]);
    const owner = await database().query<{ id: string }>("INSERT INTO users (telegram_user_id, display_name) VALUES ('700998', 'Борис') RETURNING id");
    await database().query("UPDATE family_memberships SET role = 'member' WHERE user_id = $1", [fixture.userId]);
    await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [fixture.familyId, owner.rows[0]!.id]);

    await familyDeletionRepository.deleteMember({ familyId: fixture.familyId, userId: fixture.userId });

    expect(await count("SELECT count(*) FROM users WHERE id = $1", [fixture.userId])).toBe(0);
    expect(await count(
      "SELECT count(*) FROM memory_items_all WHERE family_id = $1 AND scope = 'family' AND endorsed_by_user_id IS NULL AND endorsed_at IS NULL",
      [fixture.familyId])).toBeGreaterThan(0);
  });

  it("refuses the owner leaving and a member deleting the family", async () => {
    const fixture = await family();
    await expect(familyDeletionRepository.deleteMember({ familyId: fixture.auth.familyId, userId: fixture.userId }))
      .rejects.toMatchObject({ code: "AGENT_FAMILY_OWNER_CANNOT_LEAVE" });
    await expect(familyDeletionRepository.deleteFamily({ familyId: fixture.auth.familyId, ownerUserId: fixture.otherId }))
      .rejects.toMatchObject({ code: "AGENT_ACCESS_DENIED" });
    expect(await count("SELECT count(*) FROM families", [])).toBe(1);
  });

  it("deletes the whole family with its members", async () => {
    const fixture = await family();
    await session(fixture.auth.familyId, fixture.userId, "wrun_family_private");
    await ingress("private-memory-author");
    expect(await familyDeletionRepository.deleteFamily({ familyId: fixture.auth.familyId, ownerUserId: fixture.userId }))
      .toEqual({ members: 2 });
    expect(await count("SELECT count(*) FROM families", [])).toBe(0);
    expect(await count("SELECT count(*) FROM users", [])).toBe(0);
    expect(await count("SELECT count(*) FROM memory_items_all", [])).toBe(0);
    expect(await count("SELECT count(*) FROM telegram_group_messages", [])).toBe(0);
    expect(await count("SELECT count(*) FROM shared_tasks", [])).toBe(0);
    expect(await count("SELECT count(*) FROM feedback_messages", [])).toBe(0);
    expect(await count("SELECT count(*) FROM erased_eve_sessions WHERE eve_session_id = 'wrun_family_private'", [])).toBe(1);
    expect(await count("SELECT count(*) FROM telegram_ingress_updates", [])).toBe(0);
  });
});
