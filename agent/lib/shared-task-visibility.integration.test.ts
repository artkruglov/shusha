/**
 * Who sees a task written in a private chat (onboarding v3), on the real schema of a legacy family.
 *
 * Constructs covered:
 * - Not asked yet, a private task stays personal; after «Для семьи» it is shared and the family group lists it.
 * - «Попроси Юлю» from a private chat: participants list the family, and the assignment is a shared request she answers.
 * - «Сделать общим» and back on a task without an area; on a task whose personal area is written, a shared copy and
 *   the original removed; only the author may; a closed task and a task of someone else's are refused.
 * - A personal task is not handed over; it is made shared first.
 * - An idea or a tradition without an area goes shared and back in place, until another person planned or marked it.
 * - «Что свободно?» from a private chat lists the family's unowned tasks only.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { sharedTaskRepository as tasks } from "./shared-task-repository.js";
import { createTaskFamilyFixture, makeTask } from "./shared-task.integration-fixtures.js";
import { sharedTaskVisibility, writeDefaultTaskVisibility } from "./shared-task-visibility.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

const row = async (id: string) => (await database().query<{ scope: string; space_id: string | null; status: string; assignee_telegram_id: string | null }>(
  "SELECT scope, space_id, status, assignee_telegram_id FROM shared_tasks WHERE id = $1", [id])).rows[0]!;

(enabled ? describe : describe.skip)("task visibility from a private chat", () => {
  let owner: MemoryAuthorization;
  let member: MemoryAuthorization;
  let familyGroup: MemoryAuthorization;

  beforeEach(async () => {
    ({ owner, member, familyGroup } = await createTaskFamilyFixture());
  });
  afterAll(closeDatabase);

  const groupTitles = async () => ((await tasks.execute(familyGroup, { action: "list" } as never, "read")).tasks ?? [])
    .map((task) => task.title);

  it("writes personal until the person chooses «Для семьи», then shared and seen by the family group", async () => {
    const before = await makeTask(member, "Купить шины");
    expect((await row(before.id)).scope).toBe("personal");
    expect(await groupTitles()).not.toContain("Купить шины");

    await writeDefaultTaskVisibility({ familyId: member.familyId, userId: member.userId!, visibility: "family" });
    const after = await makeTask(member, "Забрать очки");
    expect(await row(after.id)).toMatchObject({ assignee_telegram_id: "700102", scope: "family", space_id: null, status: "accepted" });
    expect(await groupTitles()).toContain("Забрать очки");
  });

  it("asks another adult from a private chat: the family is listed and the request is shared", async () => {
    const listed = (await tasks.execute(member, { action: "participants" } as never, "read")) as { participants: Array<{ name: string; participantRef: string }> };
    expect(listed.participants.map((person) => person.name).sort()).toEqual(["Member", "Owner"]);
    const owner700101 = listed.participants.find((person) => person.name === "Owner")!.participantRef;
    const asked = (await tasks.execute(member, { action: "create", assigneeRef: owner700101, title: "Купить шины" } as never, randomUUID())).task!;
    expect(await row(asked.id)).toMatchObject({ assignee_telegram_id: "700101", scope: "family", status: "proposed" });
    // The one asked sees it in their own private chat and answers.
    const promised = (await tasks.execute(owner, { action: "list", view: "promised" } as never, "read")).tasks!;
    expect(promised.map((task) => task.title)).toContain("Купить шины");
    // «Запиши мне» names oneself: still one's own personal task.
    const self = listed.participants.find((person) => person.name === "Member")!.participantRef;
    const mine = (await tasks.execute(member, { action: "create", assigneeRef: self, title: "Себе" } as never, randomUUID())).task!;
    expect((await row(mine.id)).scope).toBe("personal");
  });

  it("makes a task shared and personal again, and copies one whose personal area is written", async () => {
    const task = await makeTask(owner, "Записаться к врачу");
    const shared = await sharedTaskVisibility.change(owner, { id: task.id, version: task.version, visibility: "family" }, randomUUID());
    expect(shared.task.id).toBe(task.id);
    expect((await row(task.id)).scope).toBe("family");
    expect(await groupTitles()).toContain("Записаться к врачу");
    const key = randomUUID();
    await sharedTaskVisibility.change(owner, { id: task.id, version: shared.task.version, visibility: "personal" }, key);
    expect((await row(task.id)).scope).toBe("personal");
    // The same tap again is a replay.
    expect((await sharedTaskVisibility.change(owner, { id: task.id, version: shared.task.version, visibility: "personal" }, key)).replayed).toBe(true);

    const space = (await database().query<{ id: string }>(
      "INSERT INTO spaces(family_id, kind, title, owner_user_id, state) VALUES ($1, 'personal', 'Личное', $2, 'active') RETURNING id",
      [owner.familyId, owner.userId])).rows[0]!.id;
    const old = await makeTask(owner, "Повесить шторы");
    await database().query("UPDATE shared_tasks SET space_id = $2 WHERE id = $1", [old.id, space]);
    const copied = await sharedTaskVisibility.change(owner, { id: old.id, version: old.version, visibility: "family" }, randomUUID());
    expect(copied.task.id).not.toBe(old.id);
    expect(await row(copied.task.id)).toMatchObject({ scope: "family", space_id: null, status: "accepted" });
    expect((await row(old.id)).status).toBe("cancelled");
  });

  it("lets only the author change it, never a closed one, and hands over only a shared task", async () => {
    const task = await makeTask(owner, "Купить хлеб");
    await expect(sharedTaskVisibility.change(member, { id: task.id, version: task.version, visibility: "family" }, randomUUID()))
      .rejects.toMatchObject({ code: "AGENT_TASK_ACCESS_DENIED" });
    const listed = (await tasks.execute(owner, { action: "participants" } as never, "read")) as { participants: Array<{ name: string; participantRef: string }> };
    const memberRef = listed.participants.find((person) => person.name === "Member")!.participantRef;
    await expect(tasks.execute(owner, { action: "transfer", assigneeRef: memberRef, id: task.id, version: task.version } as never, randomUUID()))
      .rejects.toMatchObject({ code: "AGENT_TASK_PERSONAL_HANDOVER" });
    const done = (await tasks.execute(owner, { action: "complete", id: task.id, version: task.version } as never, randomUUID())).task!;
    await expect(sharedTaskVisibility.change(owner, { id: task.id, version: done.version, visibility: "family" }, randomUUID()))
      .rejects.toMatchObject({ code: "AGENT_TASK_VISIBILITY_CLOSED" });
  });

  it("refuses to copy a task with its own plan, and never changes who sees an idea", async () => {
    const space = (await database().query<{ id: string }>(
      "INSERT INTO spaces(family_id, kind, title, owner_user_id, state) VALUES ($1, 'personal', 'Личное', $2, 'active') RETURNING id",
      [owner.familyId, owner.userId])).rows[0]!.id;
    const planned = await makeTask(owner, "Справка в бассейн");
    await tasks.execute(owner, { action: "plan", id: planned.id, plannedFrom: "2026-10-20", plannedUntil: "2026-10-21" } as never, randomUUID());
    const current = (await database().query<{ version: number }>("SELECT version FROM shared_tasks WHERE id = $1", [planned.id])).rows[0]!.version;
    await database().query("UPDATE shared_tasks SET space_id = $2 WHERE id = $1", [planned.id, space]);
    await expect(sharedTaskVisibility.change(owner, { id: planned.id, version: current, visibility: "family" }, randomUUID()))
      .rejects.toMatchObject({ code: "AGENT_TASK_VISIBILITY_ATTACHED" });
    expect((await row(planned.id)).status).toBe("accepted");

    const idea = (await tasks.execute(owner, { action: "create", kind: "idea", title: "Поход в выходные" } as never, randomUUID())).task!;
    await database().query("UPDATE shared_tasks SET space_id = $2 WHERE id = $1", [idea.id, space]);
    await expect(sharedTaskVisibility.change(owner, { id: idea.id, version: idea.version, visibility: "family" }, randomUUID()))
      .rejects.toMatchObject({ code: "AGENT_TASK_ACCESS_DENIED" });
  });

  it("writes a tradition from a private chat as the author's own until shared, and shares an older one in place", async () => {
    const ritual = (await tasks.execute(owner, { action: "create", kind: "ritual", title: "Блины в воскресенье" } as never, randomUUID())).task!;
    expect(await row(ritual.id)).toMatchObject({ scope: "personal", space_id: null });
    expect(await groupTitles()).not.toContain("Блины в воскресенье");

    const older = (await tasks.execute(owner, { action: "create", kind: "idea", title: "Поход в выходные" } as never, randomUUID())).task!;
    await database().query("UPDATE shared_tasks SET kind = 'ritual' WHERE id = $1", [older.id]);
    expect((await row(older.id)).scope).toBe("personal");
    const shared = await sharedTaskVisibility.change(owner, { id: older.id, version: older.version, visibility: "family" }, randomUUID());
    expect(shared.task.id).toBe(older.id);
    expect(await row(older.id)).toMatchObject({ scope: "family", space_id: null, status: "accepted" });
    expect(await groupTitles()).toContain("Поход в выходные");
    const now = (await database().query<{ version: number }>("SELECT version FROM shared_tasks WHERE id = $1", [older.id])).rows[0]!.version;
    await expect(sharedTaskVisibility.change(member, { id: older.id, version: now, visibility: "personal" }, randomUUID()))
      .rejects.toMatchObject({ code: "AGENT_TASK_ACCESS_DENIED" });
    // Nobody else picked it up yet: the author takes it back.
    const back = await sharedTaskVisibility.change(owner, { id: older.id, version: now, visibility: "personal" }, randomUUID());
    expect(back.task.id).toBe(older.id);
    expect((await row(older.id)).scope).toBe("personal");
    expect(await groupTitles()).not.toContain("Поход в выходные");
  });

  it("keeps a shared idea or tradition shared once another person planned or marked it", async () => {
    const version = async (id: string) =>
      (await database().query<{ version: number }>("SELECT version FROM shared_tasks WHERE id = $1", [id])).rows[0]!.version;
    const ritual = (await tasks.execute(owner, { action: "create", kind: "ritual", title: "Настолки по средам" } as never, randomUUID(), { visibility: "family" })).task!;
    await tasks.execute(member, { action: "record", id: ritual.id, note: "Сыграли", occurredOn: "2026-10-14" } as never, randomUUID());
    await expect(sharedTaskVisibility.change(owner, { id: ritual.id, version: await version(ritual.id), visibility: "personal" }, randomUUID()))
      .rejects.toMatchObject({ code: "AGENT_TASK_VISIBILITY_SHARED_WORK" });
    expect((await row(ritual.id)).scope).toBe("family");

    await writeDefaultTaskVisibility({ familyId: owner.familyId, userId: owner.userId!, visibility: "family" });
    const idea = (await tasks.execute(owner, { action: "create", kind: "idea", title: "Музей в субботу" } as never, randomUUID())).task!;
    expect((await row(idea.id)).scope).toBe("family");
    await tasks.execute(member, { action: "plan", id: idea.id, plannedFrom: "2026-10-24", plannedUntil: "2026-10-24" } as never, randomUUID());
    await expect(sharedTaskVisibility.change(owner, { id: idea.id, version: await version(idea.id), visibility: "personal" }, randomUUID()))
      .rejects.toMatchObject({ code: "AGENT_TASK_VISIBILITY_SHARED_WORK" });

    // The author's own plan and mark do not hold it.
    const own = (await tasks.execute(owner, { action: "create", kind: "ritual", title: "Чай без телефонов" } as never, randomUUID(), { visibility: "family" })).task!;
    await tasks.execute(owner, { action: "record", id: own.id, note: "Было", occurredOn: "2026-10-14" } as never, randomUUID());
    await sharedTaskVisibility.change(owner, { id: own.id, version: await version(own.id), visibility: "personal" }, randomUUID());
    expect((await row(own.id)).scope).toBe("personal");
  });

  it("answers «что свободно?» in a private chat with the family's unowned tasks, not with one's own", async () => {
    await makeTask(member, "Своё личное");
    const free = (await tasks.execute(familyGroup, { action: "create", title: "Вынести мусор", unassigned: true } as never, randomUUID())).task!;
    await tasks.execute(familyGroup, { action: "create", title: "Взял владелец" } as never, randomUUID());
    const taken = (await tasks.execute(familyGroup, { action: "create", title: "Взял владелец в группе", unassigned: true } as never, randomUUID())).task!;
    await tasks.execute(familyGroup, { action: "claim", id: taken.id, version: taken.version } as never, randomUUID());
    const open = (await tasks.execute(member, { action: "list", view: "open" } as never, "read")).tasks!;
    expect(open.map((task) => task.id)).toEqual([free.id]);
    // Taken in the family group, it is no longer free.
    await tasks.execute(familyGroup, { action: "claim", id: free.id, version: free.version } as never, randomUUID());
    expect((await tasks.execute(member, { action: "list", view: "open" } as never, "read")).tasks).toEqual([]);
  });
});
