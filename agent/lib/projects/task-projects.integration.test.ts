/**
 * Проекты области на реальной PostgreSQL: имя находит один проект, личное и семейное не смешиваются,
 * проект не попадает в список дел, жизненный цикл и перенос дел (миграция 161).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const currentMember = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../telegram-current-membership.js", () => ({ isCurrentTelegramMember: currentMember }));
import { closeDatabase, database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { sharedTaskRepository as tasks } from "../shared-task-repository.js";
import { createTaskFamilyFixture } from "../shared-task.integration-fixtures.js";
import { projectRepository as projects } from "./project-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw Error("Unsafe test database");
const suite = enabled ? describe : describe.skip;
let owner: MemoryAuthorization, member: MemoryAuthorization, familyGroup: MemoryAuthorization, memberGroup: MemoryAuthorization;

const create = (auth: MemoryAuthorization, title: string, listName?: string) =>
  tasks.execute(auth, { action: "create", title, ...(listName ? { listName } : {}) }, randomUUID());
const titles = async (auth: MemoryAuthorization) =>
  (await projects.execute(auth, { action: "list" })).projects!.map((project) => project.title);

suite("task projects", () => {
  beforeEach(async () => {
    currentMember.mockResolvedValue(true);
    ({ owner, member, familyGroup } = await createTaskFamilyFixture());
    memberGroup = { ...member, groupId: familyGroup.groupId, scopes: ["family"] };
  });
  afterAll(closeDatabase);

  it("finds one project for names that differ only by case, yo and spacing", async () => {
    await create(owner, "Отвезти матрас", "Переезд");
    await create(owner, "Купить коробки", "  переезд ");
    await create(owner, "Сдать ключи", "Работа  ·Яндекс");
    await create(owner, "Созвон", "работа · яндекс");

    const listed = (await projects.execute(owner, { action: "list" })).projects!;
    expect(listed.map((project) => [project.title, project.total])).toEqual([["Переезд", 2], ["Работа · Яндекс", 2]]);
  });

  it("keeps a personal project apart from a family one with the same name, and from other people", async () => {
    await create(owner, "Личное дело", "Дом");
    await create(familyGroup, "Общее дело", "Дом");
    await create(owner, "Только моё", "Переезд");

    // В личке владелец видит свои проекты и семейные; семья и второй человек не видят личного.
    expect((await projects.execute(owner, { action: "list" })).projects!.map((project) => `${project.title}/${project.source}`).sort())
      .toEqual(["Дом/Личное", "Дом/Семья", "Переезд/Личное"]);
    expect(await titles(familyGroup)).toEqual(["Дом"]);
    expect(await titles(memberGroup)).toEqual(["Дом"]);
    expect(await titles(member)).toEqual(["Дом"]);
  });

  it("never shows a project as a task and keeps it out of the task views", async () => {
    await create(owner, "Отвезти матрас", "Переезд");

    const listed = (await tasks.execute(owner, { action: "list" }, "read")).tasks!;
    expect(listed.map((task) => [task.title, task.kind, task.listName])).toEqual([["Отвезти матрас", "task", "Переезд"]]);
    expect((await tasks.execute(owner, { action: "list", view: "inbox" }, "read")).tasks!.every((task) => task.kind !== "project")).toBe(true);
    expect((await tasks.execute(owner, { action: "list", listName: "ПЕРЕЕЗД" }, "read")).tasks).toHaveLength(1);
    const project = (await projects.execute(owner, { action: "list" })).projects![0]!;
    await expect(tasks.execute(owner, { action: "get", id: project.id }, "read")).rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
  });

  it("creates a project together with its first step, and finds it again instead of duplicating", async () => {
    const made = await projects.execute(familyGroup, {
      action: "create", details: "Поехать в августе на две недели", lifeArea: "couple", nextStep: { title: "Обсудить даты" }, title: "Отпуск",
    });
    expect(made).toMatchObject({ created: true, project: { hasNextStep: true, lifeArea: "couple", open: 1, title: "Отпуск", total: 1 } });
    expect(made.nextStep?.title).toBe("Обсудить даты");

    const again = await projects.execute(familyGroup, { action: "create", title: "отпуск" });
    expect(again).toMatchObject({ created: false, project: { id: made.project!.id, total: 1 } });
  });

  it("closes a project only when its tasks are done, then reopens it", async () => {
    const made = await projects.execute(familyGroup, { action: "create", nextStep: { title: "Выбрать даты" }, title: "Отпуск" });
    let { id, version } = made.project!;
    await expect(projects.execute(familyGroup, { action: "complete", id, version })).rejects.toThrow(/AGENT_PROJECT_HAS_OPEN_TASKS/);

    await tasks.execute(familyGroup, { action: "complete", id: made.nextStep!.id }, randomUUID());
    const done = await projects.execute(familyGroup, { action: "complete", id, version });
    expect(done.project).toMatchObject({ completed: 1, status: "completed" });
    expect(await titles(familyGroup)).toEqual([]);
    expect((await projects.execute(familyGroup, { action: "list", includeClosed: true })).projects).toHaveLength(1);

    // Закрытый проект не мешает завести живой с тем же именем, но поднять старый тогда нельзя.
    ({ version } = done.project!);
    await projects.execute(familyGroup, { action: "create", title: "Отпуск" });
    await expect(projects.execute(familyGroup, { action: "reopen", id, version })).rejects.toThrow(/AGENT_PROJECT_DUPLICATE/);
  });

  it("detaches the open tasks when a project is cancelled and leaves the finished ones", async () => {
    await create(familyGroup, "Шаг один", "Ремонт");
    const second = (await create(familyGroup, "Шаг два", "Ремонт")).task!;
    await tasks.execute(familyGroup, { action: "complete", id: second.id }, randomUUID());
    const project = (await projects.execute(familyGroup, { action: "list" })).projects![0]!;

    const cancelled = await projects.execute(familyGroup, { action: "cancel", id: project.id, version: project.version });
    expect(cancelled.detachedTasks).toEqual(["Шаг один"]);
    const open = (await tasks.execute(familyGroup, { action: "list" }, "read")).tasks!;
    expect(open.map((task) => [task.title, task.listName])).toEqual([["Шаг один", null]]);
    expect((await database().query("SELECT count(*)::int n FROM shared_task_versions WHERE action='project_detach'")).rows[0].n).toBe(1);
  });

  it("merges two projects of one area: tasks move, the source is cancelled, history is kept", async () => {
    await create(familyGroup, "Купить диван", "Квартира");
    await create(familyGroup, "Заказать матрас", "Переезд");
    const [flat, move] = (await projects.execute(familyGroup, { action: "list" })).projects!;
    const from = flat!.title === "Квартира" ? flat! : move!;
    const into = from === flat ? move! : flat!;

    const merged = await projects.execute(memberGroup, { action: "merge", id: from.id, intoId: into.id, version: from.version });
    expect(merged.mergedInto).toBe(into.title);
    expect(merged.project?.status).toBe("cancelled");
    expect((await projects.execute(familyGroup, { action: "list" })).projects).toMatchObject([{ id: into.id, total: 2 }]);
    expect((await tasks.execute(familyGroup, { action: "list", listName: into.title }, "read")).tasks).toHaveLength(2);
    expect((await database().query("SELECT count(*)::int n FROM shared_task_versions WHERE action='project_merge'")).rows[0].n).toBe(2);
  });

  it("does not let a personal project be merged into a family one or touched by another person", async () => {
    await create(owner, "Личное", "Переезд");
    await create(familyGroup, "Общее", "Дом");
    const personal = (await projects.execute(owner, { action: "list" })).projects!.find((project) => project.source === "Личное")!;
    const family = (await projects.execute(owner, { action: "list" })).projects!.find((project) => project.source === "Семья")!;

    await expect(projects.execute(owner, { action: "merge", id: personal.id, intoId: family.id, version: personal.version }))
      .rejects.toThrow(/AGENT_PROJECT_SCOPE_MISMATCH/);
    // Второй человек не видит чужого личного проекта: для него его нет.
    await expect(projects.execute(member, { action: "update", id: personal.id, title: "Моё", version: personal.version }))
      .rejects.toThrow(/AGENT_TASK_ACCESS_DENIED/);
    // Общий проект правит любой участник семьи: ограничение «сначала спросить» живёт в правиле агента.
    const renamed = await projects.execute(memberGroup, { action: "update", id: family.id, title: "Дом и сад", version: family.version });
    expect(renamed.project?.title).toBe("Дом и сад");
  });

  it("refuses a stale version and a rename that collides with a live project", async () => {
    await create(familyGroup, "Один", "Дом");
    await create(familyGroup, "Два", "Сад");
    const [home, garden] = (await projects.execute(familyGroup, { action: "list" })).projects!;
    await expect(projects.execute(familyGroup, { action: "update", id: home!.id, title: "Новое", version: home!.version + 5 }))
      .rejects.toThrow(/AGENT_PROJECT_VERSION_CONFLICT/);
    await expect(projects.execute(familyGroup, { action: "update", id: home!.id, title: garden!.title.toUpperCase(), version: home!.version }))
      .rejects.toThrow(/AGENT_PROJECT_DUPLICATE/);
  });

  it("is backed by a database guard: a task cannot be pointed at a project of another area", async () => {
    const mine = (await create(owner, "Личное", "Переезд")).task!;
    await create(familyGroup, "Общее", "Дом");
    const family = (await projects.execute(familyGroup, { action: "list" })).projects![0]!;

    await expect(database().query("UPDATE shared_tasks SET project_id=$2 WHERE id=$1", [mine.id, family.id]))
      .rejects.toThrow(/AGENT_TASK_PROJECT_SCOPE_MISMATCH/);
  });
});
