/**
 * The Mini App API on the real schema: identity only from signed `initData`, rights from the task
 * repository, as a private chat turn has them.
 *
 * Constructs covered:
 * - The board lists the person's own task with its id and version; «Сделано» closes it, «Вернуть» opens it.
 * - «Беру / Не могу» answer a request to the person, «Беру» takes an unowned task, «Перенести» moves the date.
 * - An action outside the whitelist or a day it does not know is 400.
 * - A repeated tap with the same nonce is a replay, not a second change; a stale version is 409.
 * - A family member cannot close a task the family group assigned to someone else.
 * - A Telegram user outside the family gets 403; unsigned or foreign-signed data gets 401.
 * - An external group's task is never on the board and cannot be changed from it.
 * - The card shows the task's history and the buttons that fit; another member's personal task has no card.
 * - «Снять», «Перенести» to a chosen day and «Добавить дело»; days outside a year are refused.
 * - The card of an idea or a tradition offers its author «who sees it» while nobody else picked it up.
 * - «Добавить дело» takes «для семьи» or «только мне»; the first explicit choice becomes the default.
 * - «Закрытые» lists the week's done and removed tasks the person may see, with «Вернуть» on their own.
 * - «Передать…» offers a family task to another person, who only answers it; it stays the sender's until taken.
 */
import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const currentMember = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../telegram-current-membership.js", () => ({ isCurrentTelegramMember: currentMember }));

import { closeDatabase, database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { sharedTaskRepository as tasks } from "../shared-task-repository.js";
import { createTaskFamilyFixture, makeTask } from "../shared-task.integration-fixtures.js";
import { createWebAppApi, postponedTo, webAppApiDependencies } from "./web-app-api.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

const TOKEN = "123456:web-app-test";

function initData(telegramUserId: string, token = TOKEN): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ first_name: "Тест", id: Number(telegramUserId) }),
  };
  const check = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}

(enabled ? describe : describe.skip)("Mini App API", () => {
  let owner: MemoryAuthorization;
  let member: MemoryAuthorization;
  let familyGroup: MemoryAuthorization;
  // The production wiring with only the token swapped: the same identity, board and repository path.
  const api = createWebAppApi({ ...webAppApiDependencies, botToken: () => TOKEN });

  const board = (who: string, token?: string) =>
    api.board(new Request("https://x/app-api/board", { headers: { authorization: `tma ${initData(who, token)}` } }));
  const change = (who: string, action: string, id: string, body: unknown) =>
    api.task(new Request(`https://x/app-api/tasks/${id}/${action}`, {
      body: JSON.stringify(body), headers: { authorization: `tma ${initData(who)}` }, method: "POST",
    }), { action, id });
  const rowsOf = async (who: string) =>
    ((await (await board(who)).json()) as { sections: Array<{ rows: Array<{ actions: string[]; id: string | null; title: string }> }> })
      .sections.flatMap((section) => section.rows);
  async function familyTask(title: string, status: "open" | "proposed", assignee: string | null) {
    const task = (await tasks.execute(familyGroup, { action: "create", title } as never, `create-${title}`)).task!;
    await database().query(
      "UPDATE shared_tasks SET status=$2, assignee_telegram_id=$3, version=version+1 WHERE id=$1", [task.id, status, assignee]);
    return { id: task.id, title, version: task.version + 1 };
  }
  const auth = (who: string) => ({ authorization: `tma ${initData(who)}` });
  const card = async (who: string, id: string) =>
    api.card(new Request(`https://x/app-api/tasks/${id}`, { headers: auth(who) }), { id });
  const closedWeek = async (who: string) =>
    (await api.closed(new Request("https://x/app-api/closed", { headers: auth(who) }))).json() as Promise<{
      cancelled: Array<{ canReopen: boolean; title: string }>; done: Array<{ canReopen: boolean; detail: string; title: string }>;
    }>;
  const create = (who: string, body: unknown) =>
    api.create(new Request("https://x/app-api/tasks", { body: JSON.stringify(body), headers: auth(who), method: "POST" }));
  const status = async (id: string) =>
    (await database().query<{ status: string }>("SELECT status FROM shared_tasks WHERE id=$1", [id])).rows[0]!.status;

  beforeEach(async () => {
    currentMember.mockResolvedValue(true);
    ({ owner, member, familyGroup } = await createTaskFamilyFixture());
  });
  afterAll(closeDatabase);

  it("shows the person's task, closes it, replays the same tap and opens it again", async () => {
    const task = await makeTask(owner, "Подготовить видео");
    const response = await board("700101");
    expect(response.status).toBe(200);
    const shown = (await response.json()) as { sections: Array<{ rows: Array<{ id: string; title: string; version: number }> }> };
    const row = shown.sections.flatMap((section) => section.rows).find((item) => item.title === "Подготовить видео");
    expect(row).toMatchObject({ id: task.id, version: task.version });

    const nonce = randomUUID();
    const closed = await change("700101", "complete", task.id, { nonce, version: task.version });
    expect(closed.status).toBe(200);
    const { task: after } = (await closed.json()) as { task: { status: string; version: number } };
    expect(after.status).toBe("completed");
    expect(await status(task.id)).toBe("completed");

    const again = await change("700101", "complete", task.id, { nonce, version: task.version });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { task: { version: number } }).task.version).toBe(after.version);

    const stale = await change("700101", "complete", task.id, { nonce: randomUUID(), version: task.version });
    expect(stale.status).toBe(409);

    const reopened = await change("700101", "reopen", task.id, { nonce: randomUUID(), version: after.version });
    expect(reopened.status).toBe(200);
    expect(await status(task.id)).toBe("accepted");
  });

  it("hands a family task over: the recipient only answers it, and it stays the sender's until they take it", async () => {
    const own = await makeTask(owner, "Записать Мишу к врачу");
    const people = (await (await api.participants(new Request("https://x/app-api/participants", { headers: auth("700101") }))).json()) as {
      participants: Array<{ me: boolean; ref: string }>;
    };
    const yulia = people.participants.find((person) => !person.me)!;
    // A personal task is not handed over: it is made shared by its own button first.
    expect((await change("700101", "transfer", own.id, { assigneeRef: yulia.ref, nonce: randomUUID(), version: own.version })).status)
      .toBeGreaterThanOrEqual(400);
    expect((await database().query("SELECT scope FROM shared_tasks WHERE id=$1", [own.id])).rows[0]).toEqual({ scope: "personal" });
    const { task } = (await (await change("700101", "share", own.id, { nonce: randomUUID(), version: own.version })).json()) as {
      task: { id: string; version: number };
    };
    const sent = await change("700101", "transfer", task.id, { assigneeRef: yulia.ref, nonce: randomUUID(), version: task.version });
    expect(sent.status).toBe(200);
    const { task: offered } = (await sent.json()) as { task: { id: string; version: number } };
    const row = async () => (await database().query<{ assignee_telegram_id: string; pending_assignee_telegram_id: string | null }>(
      "SELECT assignee_telegram_id, pending_assignee_telegram_id FROM shared_tasks WHERE id=$1", [task.id])).rows[0]!;
    expect(await row()).toEqual({ assignee_telegram_id: "700101", pending_assignee_telegram_id: "700102" });
    const theirs = (await (await card("700102", task.id)).json()) as { task: { actions: string[]; waiting: string } };
    expect(theirs.task.actions).toEqual(["accept_transfer", "decline_transfer"]);
    expect(theirs.task.waiting).toMatch(/передаёт вам это дело$/u);
    // Before taking it, the recipient changes nothing else.
    for (const action of ["complete", "cancel"]) {
      expect((await change("700102", action, task.id, { nonce: randomUUID(), version: offered.version })).status).toBeGreaterThanOrEqual(400);
    }
    expect(await row()).toEqual({ assignee_telegram_id: "700101", pending_assignee_telegram_id: "700102" });
    // «Не могу» from the recipient: the offer is gone, the task stays the sender's.
    expect((await change("700102", "decline_transfer", task.id, { nonce: randomUUID(), version: offered.version })).status).toBe(200);
    expect(await row()).toEqual({ assignee_telegram_id: "700101", pending_assignee_telegram_id: null });
    // Offered again and taken.
    const again = (await (await change("700101", "transfer", task.id, { assigneeRef: yulia.ref, nonce: randomUUID(), version: offered.version + 1 })).json()) as {
      task: { version: number };
    };
    // Changed by the sender after the card was read: agreeing to the old card is a conflict, not taking the new task.
    await database().query("UPDATE shared_tasks SET title='Другое дело', version=version+1 WHERE id=$1", [task.id]);
    expect((await change("700102", "accept_transfer", task.id, { nonce: randomUUID(), version: again.task.version })).status).toBe(409);
    expect((await change("700102", "decline_transfer", task.id, { nonce: randomUUID(), version: again.task.version })).status).toBe(409);
    expect((await row()).pending_assignee_telegram_id).toBe("700102");
    expect((await change("700102", "accept_transfer", task.id, { nonce: randomUUID(), version: again.task.version + 1 })).status).toBe(200);
    expect((await row()).assignee_telegram_id).toBe("700102");
    expect((await change("700101", "transfer", task.id, { assigneeRef: "Юля", nonce: randomUUID(), version: again.task.version + 2 })).status)
      .toBe(400);
  });

  it("answers a request to the person with «Беру» or «Не могу», as offered on their board", async () => {
    const parcel = await familyTask("Забрать посылку", "proposed", "700102");
    const filter = await familyTask("Заказать фильтры", "proposed", "700102");
    const rows = await rowsOf("700102");
    expect(rows.find((row) => row.title === "Забрать посылку")).toMatchObject({ actions: ["accept", "decline"], id: parcel.id });
    // The author sees their own request waiting, with nothing to press.
    expect((await rowsOf("700101")).find((row) => row.title === "Забрать посылку")).toMatchObject({ actions: [], id: parcel.id });

    expect((await change("700102", "accept", parcel.id, { nonce: randomUUID(), version: parcel.version })).status).toBe(200);
    expect(await status(parcel.id)).toBe("accepted");
    expect((await change("700102", "decline", filter.id, { nonce: randomUUID(), version: filter.version })).status).toBe(200);
    expect(await status(filter.id)).toBe("declined");
    // Only the recipient answers: the author cannot accept on their behalf.
    const other = await familyTask("Позвонить в сервис", "proposed", "700102");
    const refused = await change("700101", "accept", other.id, { nonce: randomUUID(), version: other.version });
    expect(refused.status).toBe(422);
    expect(await status(other.id)).toBe("proposed");
  });

  it("takes an unowned task the person created with «Беру»", async () => {
    const trash = await familyTask("Вынести мусор", "open", null);
    const response = await change("700101", "claim", trash.id, { nonce: randomUUID(), version: trash.version });
    expect(response.status).toBe(200);
    expect(await status(trash.id)).toBe("accepted");
  });

  it("moves the person's own task to tomorrow, and refuses an unknown action or day", async () => {
    const task = await makeTask(owner, "Записаться к врачу");
    expect((await rowsOf("700101")).find((row) => row.title === "Записаться к врачу")!.actions).toEqual(["complete", "postpone"]);
    const today = await webAppApiDependencies.today(owner);
    const tap = { nonce: randomUUID(), on: today, to: "tomorrow", version: task.version };
    const moved = await change("700101", "postpone", task.id, tap);
    expect(moved.status).toBe(200);
    // The same tap again is a replay: the date counts from the day the board was read, not from now.
    expect((await change("700101", "postpone", task.id, tap)).status).toBe(200);
    const row = (await database().query<{ due_on: string }>("SELECT due_on::text FROM shared_tasks WHERE id=$1", [task.id])).rows[0]!;
    expect(row.due_on).toBe(postponedTo(today, "tomorrow"));

    const version = ((await moved.json()) as { task: { version: number } }).task.version;
    expect((await change("700101", "postpone", task.id, { nonce: randomUUID(), on: today, to: "someday", version })).status).toBe(400);
    // A board read long ago cannot set a date in the past.
    expect((await change("700101", "postpone", task.id, { nonce: randomUUID(), on: "2026-01-01", to: "today", version })).status).toBe(400);
    expect((await change("700101", "transfer", task.id, { nonce: randomUUID(), version })).status).toBe(400);
    expect(await status(task.id)).toBe("accepted");
  });

  it("leaves rights to the task repository: another member cannot close the author's group task", async () => {
    const task = (await tasks.execute(familyGroup, { action: "create", title: "Вынести мусор" } as never, "group-create")).task!;
    const response = await change("700102", "complete", task.id, { nonce: randomUUID(), version: task.version });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await status(task.id)).not.toBe("completed");
  });

  it("refuses a person outside the family and data not signed by this bot", async () => {
    await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES('700301','Чужой')");
    const stranger = await board("700301");
    expect(stranger.status).toBe(403);
    expect(((await stranger.json()) as { code: string }).code).toBe("AGENT_ACCESS_DENIED");

    expect((await board("700101", "999:other-bot")).status).toBe(401);
    const unsigned = await api.board(new Request("https://x/app-api/board"));
    expect(unsigned.status).toBe(401);
    const task = await makeTask(owner, "Купить хлеб");
    const bad = await change("700101", "complete", task.id, { nonce: "x", version: task.version });
    expect(bad.status).toBe(400);
    expect(await status(task.id)).toBe("accepted");
  });

  it("never shows or changes an external group's task, though a private chat may show it", async () => {
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, tool_allowlist, message_mode)
       VALUES($1,'-100777','ext','external',ARRAY['manage_shared_tasks'],'addressed_only') RETURNING id`, [owner.familyId]);
    const external: MemoryAuthorization = { ...owner, groupId: group.rows[0]!.id, scopes: ["group"] };
    const task = (await tasks.execute(external, { action: "create", title: "Внешнее дело" } as never, "ext-create")).task!;
    // The private chat's own list still has it: the rule is the Mini App's, not a new chat rule.
    expect((await tasks.execute(owner, { action: "list" } as never, "read")).tasks?.map((row) => row.title)).toContain("Внешнее дело");

    const shown = (await (await board("700101")).json()) as { sections: Array<{ rows: Array<{ title: string }> }> };
    expect(shown.sections.flatMap((section) => section.rows).map((row) => row.title)).not.toContain("Внешнее дело");
    const response = await change("700101", "complete", task.id, { nonce: randomUUID(), version: task.version });
    expect(response.status).toBe(403);
    expect(await status(task.id)).not.toBe("completed");
  });

  it("shows the card with its history and buttons, and no card of another member's personal task", async () => {
    const task = await makeTask(owner, "Заказать матрас");
    const today = await webAppApiDependencies.today(owner);
    await change("700101", "postpone", task.id, { nonce: randomUUID(), on: today, to: "tomorrow", version: task.version });
    const response = await card("700101", task.id);
    expect(response.status).toBe(200);
    const { task: shown } = (await response.json()) as { task: { actions: string[]; history: Array<{ text: string }>; title: string } };
    expect(shown.title).toBe("Заказать матрас");
    expect(shown.actions).toEqual(["complete", "postpone", "cancel", "share"]);
    expect(shown.history.map((entry) => entry.text)).toEqual([
      "Owner · создано", expect.stringMatching(/^Owner · перенос: без срока → \d+ [а-я]+$/u),
    ]);
    expect((await card("700102", task.id)).status).toBe(404);
    expect((await card("700101", randomUUID())).status).toBe(404);
  });

  it("makes the author's own task shared from its card and personal again", async () => {
    const task = await makeTask(owner, "Купить шины");
    const shared = await change("700101", "share", task.id, { nonce: randomUUID(), version: task.version });
    expect(shared.status).toBe(200);
    const { task: after } = (await shared.json()) as { task: { version: number } };
    expect((await database().query<{ scope: string }>("SELECT scope FROM shared_tasks WHERE id=$1", [task.id])).rows[0]!.scope).toBe("family");
    const { task: shown } = (await (await card("700101", task.id)).json()) as { task: { actions: string[]; visibility: string } };
    expect(shown.actions).toContain("unshare");
    expect(shown.visibility).toBe("Семья");
    expect((await change("700101", "unshare", task.id, { nonce: randomUUID(), version: after.version })).status).toBe(200);
    expect((await database().query<{ scope: string }>("SELECT scope FROM shared_tasks WHERE id=$1", [task.id])).rows[0]!.scope).toBe("personal");
    // Not the author: refused.
    expect((await change("700102", "share", task.id, { nonce: randomUUID(), version: after.version + 1 })).status).toBe(403);
  });

  it("gives the author of an idea or a tradition «who sees it» on its card, until another member marked it", async () => {
    const scopeOf = async (id: string) =>
      (await database().query<{ scope: string }>("SELECT scope FROM shared_tasks WHERE id=$1", [id])).rows[0]!.scope;
    const idea = (await tasks.execute(owner, { action: "create", kind: "idea", title: "Поход в горы" } as never, randomUUID())).task!;
    const actions = async (who: string, id: string) =>
      ((await (await card(who, id)).json()) as { task: { actions: string[] } }).task.actions;
    expect(await actions("700101", idea.id)).toEqual(["share", "cancel"]);
    const shared = (await (await change("700101", "share", idea.id, { nonce: randomUUID(), version: idea.version })).json()) as { task: { version: number } };
    expect(await scopeOf(idea.id)).toBe("family");
    expect(await actions("700101", idea.id)).toEqual(["unshare", "cancel"]);
    expect(await actions("700102", idea.id)).toEqual([]);
    expect((await change("700101", "unshare", idea.id, { nonce: randomUUID(), version: shared.task.version })).status).toBe(200);
    expect(await scopeOf(idea.id)).toBe("personal");

    const ritual = (await tasks.execute(owner, { action: "create", kind: "ritual", title: "Блины в воскресенье" } as never, randomUUID(), { visibility: "family" })).task!;
    expect(await actions("700101", ritual.id)).toEqual(["unshare", "cancel"]);
    await tasks.execute(member, { action: "record", id: ritual.id, note: "Было", occurredOn: await webAppApiDependencies.today(owner) } as never, randomUUID());
    // Marked by another member: it stays shared, and its author may still remove it.
    expect(await actions("700101", ritual.id)).toEqual(["cancel"]);
    expect((await change("700101", "cancel", ritual.id, { nonce: randomUUID(), version: ritual.version })).status).toBe(200);
    expect((await database().query("SELECT status FROM shared_tasks WHERE id=$1", [ritual.id])).rows[0]).toEqual({ status: "cancelled" });
  });

  it("adds a task for the family or only for the person in one request, and the first choice becomes the default", async () => {
    const scopeOf = async (id: string) =>
      (await database().query<{ scope: string }>("SELECT scope FROM shared_tasks WHERE id=$1", [id])).rows[0]!.scope;
    const defaultOf = async () => (await database().query<{ default_task_visibility: string | null }>(
      "SELECT default_task_visibility FROM user_notification_settings WHERE user_id=$1", [owner.userId])).rows[0]?.default_task_visibility ?? null;
    const added = async (body: Record<string, unknown>) =>
      ((await (await create("700101", { nonce: randomUUID(), ...body })).json()) as { task: { id: string } }).task.id;
    const shared = await added({ title: "Купить продукты", visibility: "family" });
    expect(await scopeOf(shared)).toBe("family");
    expect(await defaultOf()).toBe("family");
    // A later explicit choice is for this task only.
    expect(await scopeOf(await added({ title: "Записаться к стоматологу", visibility: "personal" }))).toBe("personal");
    expect(await defaultOf()).toBe("family");
    expect(await scopeOf(await added({ title: "Без выбора" }))).toBe("family");
    expect((await create("700101", { nonce: randomUUID(), title: "Странно", visibility: "everyone" })).status).toBe(400);
    expect((await create("700101", { nonce: randomUUID(), title: "Странно", visibility: null })).status).toBe(400);
  });

  it("writes a tradition and an idea from «Семья» for whom the person chose, with nothing a tradition cannot carry", async () => {
    const row = async (id: string) => (await database().query<{ kind: string; scope: string }>(
      "SELECT kind, scope FROM shared_tasks WHERE id=$1", [id])).rows[0]!;
    const added = async (body: Record<string, unknown>) =>
      ((await (await create("700101", { nonce: randomUUID(), ...body })).json()) as { task: { id: string } }).task.id;
    expect(await row(await added({ kind: "ritual", title: "Обед у мамы" }))).toEqual({ kind: "ritual", scope: "personal" });
    expect(await row(await added({ kind: "ritual", title: "Ужин без телефонов", visibility: "family" }))).toEqual({ kind: "ritual", scope: "family" });
    expect(await row(await added({ kind: "idea", title: "Керамика", visibility: "personal" }))).toEqual({ kind: "idea", scope: "personal" });
    expect((await create("700101", { kind: "project", nonce: randomUUID(), title: "Странно" })).status).toBe(400);
    expect((await create("700101", { dueOn: "2026-10-20", kind: "ritual", nonce: randomUUID(), title: "Странно" })).status).toBe(400);
  });

  it("removes a task, moves one to a chosen day, adds one, and refuses days beyond a year", async () => {
    const today = await webAppApiDependencies.today(owner);
    const old = await makeTask(owner, "Старое дело");
    expect((await change("700101", "cancel", old.id, { nonce: randomUUID(), version: old.version })).status).toBe(200);
    expect(await status(old.id)).toBe("cancelled");

    const task = await makeTask(owner, "Купить шины");
    const day = new Date(`${today}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 10);
    const chosen = day.toISOString().slice(0, 10);
    expect((await change("700101", "postpone", task.id, { dueOn: chosen, nonce: randomUUID(), to: "date", version: task.version })).status).toBe(200);
    expect((await database().query<{ due_on: string }>("SELECT due_on::text FROM shared_tasks WHERE id=$1", [task.id])).rows[0]!.due_on).toBe(chosen);
    expect((await change("700101", "postpone", task.id, { dueOn: "2099-01-01", nonce: randomUUID(), to: "date", version: task.version + 1 })).status).toBe(400);

    const added = await create("700101", { dueOn: today, nonce: randomUUID(), title: "  Позвонить в школу " });
    expect(added.status).toBe(200);
    const { task: created } = (await added.json()) as { task: { id: string; title: string } };
    expect(created.title).toBe("Позвонить в школу");
    expect((await database().query<{ due_on: string }>("SELECT due_on::text FROM shared_tasks WHERE id=$1", [created.id])).rows[0]!.due_on).toBe(today);
    // «Кому»: the family, the person first as «Мне»; asking another adult makes a shared request.
    const people = (await (await api.participants(new Request("https://x/app-api/participants", { headers: auth("700101") }))).json()) as {
      participants: Array<{ me: boolean; name: string; ref: string }>;
    };
    expect(people.participants.map((person) => [person.name, person.me])).toEqual([["Owner", true], ["Member", false]]);
    const asked = await create("700101", { assigneeRef: people.participants[1]!.ref, nonce: randomUUID(), title: "Забрать посылку" });
    const { task: request } = (await asked.json()) as { task: { id: string; status: string } };
    expect(request.status).toBe("proposed");
    expect((await database().query<{ scope: string }>("SELECT scope FROM shared_tasks WHERE id=$1", [request.id])).rows[0]!.scope).toBe("family");
    expect((await create("700101", { nonce: randomUUID(), title: " " })).status).toBe(400);
    expect((await create("700101", { dueOn: "2099-01-01", nonce: randomUUID(), title: "Далеко" })).status).toBe(400);
  });

  it("lists the week's done and removed tasks the person may see, with «Вернуть» on their own", async () => {
    const done = await makeTask(owner, "Подготовить видео");
    await change("700101", "complete", done.id, { nonce: randomUUID(), version: done.version });
    const removed = await makeTask(owner, "Лишнее дело");
    await change("700101", "cancel", removed.id, { nonce: randomUUID(), version: removed.version });
    const reopened = await makeTask(owner, "Вернули обратно");
    const closed = await change("700101", "complete", reopened.id, { nonce: randomUUID(), version: reopened.version });
    const version = ((await closed.json()) as { task: { version: number } }).task.version;
    await change("700101", "reopen", reopened.id, { nonce: randomUUID(), version });

    const week = await closedWeek("700101");
    expect(week.done).toEqual([expect.objectContaining({ canReopen: true, detail: expect.stringMatching(/^Owner · /u), title: "Подготовить видео" })]);
    expect(week.cancelled).toEqual([expect.objectContaining({ canReopen: true, title: "Лишнее дело" })]);
    // Another member's personal tasks are not theirs to see.
    const other = await closedWeek("700102");
    expect([...other.done, ...other.cancelled]).toEqual([]);
  });
});
