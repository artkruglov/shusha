/**
 * Блок проектов в контексте хода на реальной PostgreSQL: он строго по области хода. Личные проекты не
 * попадают в семейную группу, чужому человеку и чужой семье, отозванное членство ничего не видит.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const currentMember = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../telegram-current-membership.js", () => ({ isCurrentTelegramMember: currentMember }));
import { closeDatabase, database } from "../database.js";
import type { ConversationAccess } from "../family-access.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { sharedTaskRepository as tasks } from "../shared-task-repository.js";
import { createTaskFamilyFixture } from "../shared-task.integration-fixtures.js";
import { buildTaskProjectsContext } from "./project-context.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw Error("Unsafe test database");
const suite = enabled ? describe : describe.skip;
let owner: MemoryAuthorization, member: MemoryAuthorization, familyGroup: MemoryAuthorization;

const create = (auth: MemoryAuthorization, title: string, listName: string) =>
  tasks.execute(auth, { action: "create", listName, title }, randomUUID());

function access(auth: MemoryAuthorization): ConversationAccess {
  return { familyId: auth.familyId, groupId: auth.groupId, memoryScopes: auth.scopes, role: auth.role, userId: auth.userId } as unknown as ConversationAccess;
}
const block = (auth: MemoryAuthorization) =>
  buildTaskProjectsContext({ access: access(auth), actor: { id: auth.telegramUserId!, kind: "telegram_user" } });

suite("task projects context block", () => {
  beforeEach(async () => {
    currentMember.mockResolvedValue(true);
    ({ owner, member, familyGroup } = await createTaskFamilyFixture());
    await create(owner, "Отвезти матрас", "Переезд");
    await create(familyGroup, "Купить диван", "Дом");
  });
  afterAll(closeDatabase);

  it("shows an owner in private both the personal and the family projects", async () => {
    const text = (await block(owner))!;

    expect(text).toContain("«Переезд» (Личное");
    expect(text).toContain("«Дом» (Семья");
  });

  it("keeps a personal project out of the family group and away from another person", async () => {
    expect(await block(familyGroup)).not.toContain("Переезд");
    expect(await block(familyGroup)).toContain("«Дом»");
    expect(await block(member)).not.toContain("Переезд");
    expect(await block(member)).toContain("«Дом»");
  });

  it("shows another family nothing of this one", async () => {
    const other = (await database().query("INSERT INTO families(name) VALUES('Other') RETURNING id")).rows[0].id;
    const stranger = { ...member, familyId: other };

    await expect(block(stranger)).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
  });

  it("returns no block for a channel or a bot, which carry no authority over projects", async () => {
    expect(await buildTaskProjectsContext({ access: access(owner), actor: { id: "1", kind: "telegram_bot" } })).toBeNull();
  });
});
