/**
 * Две разные семьи: дела, области заботы, совместные решения, покупки и бэклог улучшений одной
 * семьи недоступны другой по прямому id и не попадают в её списки.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { careAreaRepository as areas } from "./care-areas/care-area-repository.js";
import { closeDatabase, database } from "./database.js";
import { improvementBacklogRepository as backlog } from "./improvements/improvement-backlog-repository.js";
import { jointDecisionRepository as decisions } from "./joint-decisions/joint-decision-repository.js";
import { sharedTaskRepository as tasks } from "./shared-task-repository.js";
import { shoppingRepository as shopping } from "./shopping/shopping-repository.js";
import { createTwoFamilies, memoryAuth, TWO_FAMILIES_TRUNCATE, type TwoFamilies } from "./two-families-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let f: TwoFamilies;

dbDescribe("two families: tasks, care areas, decisions, shopping, improvements", () => {
  beforeEach(async () => {
    await database().query(TWO_FAMILIES_TRUNCATE);
    f = await createTwoFamilies();
  });
  afterAll(closeDatabase);

  it("keeps shared tasks of family A out of B's reads and mutations", async () => {
    const authA = memoryAuth(f.a, f.a.owner, "group");
    const created = await tasks.execute(authA, { action: "create", title: "Секретное дело A", unassigned: true }, randomUUID());
    const task = (created as { task: { id: string; version: number } }).task;
    for (const chat of ["group", "private"] as const) {
      const authB = memoryAuth(f.b, f.b.owner, chat);
      const listed = await tasks.execute(authB, { action: "list" }, "read");
      expect(JSON.stringify(listed)).not.toContain("Секретное дело A");
      await expect(tasks.execute(authB, { action: "get", id: task.id }, "read")).rejects.toThrow();
      await expect(tasks.execute(authB, { action: "complete", id: task.id, version: task.version }, randomUUID()))
        .rejects.toThrow();
      await expect(tasks.execute(authB, { action: "update", id: task.id, version: task.version, title: "Взломано" }, randomUUID()))
        .rejects.toThrow();
    }
    const stored = await database().query("SELECT title, status FROM shared_tasks WHERE id = $1", [task.id]);
    expect(stored.rows).toEqual([{ status: "open", title: "Секретное дело A" }]);
  });

  it("keeps care areas of family A out of B's list and mutations", async () => {
    const authA = memoryAuth(f.a, f.a.owner, "group");
    const area = (await areas.execute(authA, { action: "create", title: "Секретная область A" })).area!;
    for (const chat of ["group", "private"] as const) {
      const authB = memoryAuth(f.b, f.b.owner, chat);
      expect((await areas.execute(authB, { action: "list" })).areas!.map((a) => a.id)).not.toContain(area.id);
      for (const action of ["retire", "claim", "release", "accept"] as const) {
        await expect(areas.execute(authB, { action, id: area.id, version: area.version }))
          .rejects.toThrow();
      }
    }
    // Одноимённая область в другой семье не считается дублём и не раскрывает соседнюю.
    await expect(areas.execute(memoryAuth(f.b, f.b.owner, "group"), { action: "create", title: "Секретная область A" }))
      .resolves.toMatchObject({ area: { title: "Секретная область A" } });
    const stored = await database().query(
      "SELECT status, version FROM care_areas WHERE id = $1", [area.id]);
    expect(stored.rows).toEqual([{ status: area.status, version: area.version }]);
    expect((await areas.execute(authA, { action: "list" })).areas!.map((a) => a.id)).toEqual([area.id]);
  });

  it("keeps joint decisions of family A out of B, including a forged partner", async () => {
    const authA = memoryAuth(f.a, f.a.owner, "group");
    const people = (await decisions.execute(authA, { action: "participants" }, "people")).participants!;
    const decision = (await decisions.execute(authA, {
      action: "create", partnerRef: people.find((p) => p.name === "Супруга")!.participantRef,
      title: "Секретное решение A",
    }, "create")).decision!;
    const attackers = [
      memoryAuth(f.b, f.b.owner, "group"), memoryAuth(f.b, f.b.spouse, "private"),
      // Подделка: семья B, но пользователь семьи A (участник решения).
      { ...memoryAuth(f.b, f.a.spouse, "private"), familyId: f.b.familyId },
    ];
    for (const [index, attacker] of attackers.entries()) {
      const listed = await decisions.execute(attacker, { action: "list" }, `list-${index}`).catch(() => ({ decisions: [] }));
      expect(JSON.stringify(listed)).not.toContain("Секретное решение A");
      await expect(decisions.execute(attacker, { action: "get", id: decision.id }, `get-${index}`)).rejects.toThrow();
      await expect(decisions.execute(attacker,
        { action: "answer", id: decision.id, version: decision.version, choice: "agree" }, `ans-${index}`)).rejects.toThrow();
      await expect(decisions.execute(attacker,
        { action: "cancel", id: decision.id, version: decision.version }, `cancel-${index}`)).rejects.toThrow();
    }
    const stored = await database().query("SELECT cancelled, version FROM joint_decisions WHERE id = $1", [decision.id]);
    expect(stored.rows).toEqual([{ cancelled: false, version: decision.version }]);
    expect((await database().query("SELECT count(*)::int AS n FROM joint_decision_answers")).rows[0].n).toBe(0);
  });

  it("keeps shopping items of family A out of B's list and mutations", async () => {
    const authA = memoryAuth(f.a, f.a.owner, "group");
    const added = (await shopping.execute(authA, { action: "add", listName: "Продукты", title: "Секретное молоко A" }, randomUUID())).item!;
    for (const chat of ["group", "private"] as const) {
      const authB = memoryAuth(f.b, f.b.owner, chat);
      expect(JSON.stringify(await shopping.execute(authB, { action: "list", view: "all" }, "list"))).not.toContain("Секретное молоко A");
      for (const action of ["buy", "remove"] as const) {
        await expect(shopping.execute(authB, { action, id: added.id, version: added.version }, randomUUID())).rejects.toThrow();
      }
    }
    const stored = await database().query("SELECT bought_at, removed_at, version FROM shopping_items WHERE id = $1", [added.id]);
    expect(stored.rows).toEqual([{ bought_at: null, removed_at: null, version: added.version }]);
  });

  it("keeps the improvement backlog per family: list and close by a guessed id", async () => {
    const { item } = await backlog.record({
      category: "workflow", evidence: { tool: "x" }, familyId: f.a.familyId,
      fingerprint: "0123456789abcdef", priority: "high", summary: "Секретный пункт A",
    });
    expect(await backlog.list(f.b.familyId)).toEqual([]);
    expect(await backlog.list(f.b.familyId, "done")).toEqual([]);
    await expect(backlog.close({ closedByUserId: f.b.owner.userId, familyId: f.b.familyId, id: item.id, status: "dismissed" }))
      .rejects.toThrow(/AGENT_IMPROVEMENT_NOT_FOUND/);
    // Тот же отпечаток у семьи B заводит отдельную строку, а не увеличивает счётчик семьи A.
    const other = await backlog.record({
      category: "workflow", evidence: {}, familyId: f.b.familyId, fingerprint: "0123456789abcdef", priority: "low", summary: "Пункт B",
    });
    expect(other.item.id).not.toBe(item.id);
    expect(other.recurred).toBe(false);
    const [mine] = await backlog.list(f.a.familyId);
    expect(mine).toMatchObject({ id: item.id, recurrenceCount: 1, status: "open", summary: "Секретный пункт A" });
  });
});
