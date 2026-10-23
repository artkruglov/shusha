/**
 * «Группы» Mini App на настоящей схеме: тот же путь подписанного `initData`, что у доски.
 *
 * Constructs covered:
 * - Без флага оба маршрута 404 (и `capabilities.groups` выключен в `web-app-more-api.integration.test.ts`).
 * - Список: только группы семьи человека, где Telegram подтверждает участие; ошибка Telegram значит «не показывать».
 * - Ссылка «Создать группу» только владельцу.
 * - Внешняя группа отдаёт только свои дела и традиции: ни личного, ни семейного; семейная группа без личного.
 * - Группа, из которой человек вышел, и группа другой семьи отвечают 404.
 * - Одна проверка `getChatMember` на группу за запрос, хотя репозиторий проверяет ещё раз.
 * - Больше пяти страниц дел: `more` в списке и `truncated` в группе; традиции не вытесняются идеями.
 * - Группа, не успевшая к сроку списка, в ответ не попадает, а ответ помечен `partial`.
 * - «Беру» и «Сделано» только с делом этой группы и только живому участнику её чата; повтор nonce не меняет дважды.
 * - «Позвать людей» только владельцу и только в обычной группе; без права приглашать 422.
 * - Запись в группу из приложения: только в обычную группу, где человек сейчас в чате; срок, исполнитель и проект
 *   отвергаются; запись видна на странице группы и только там.
 */
import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The Telegram transport itself is stubbed, so the real membership check and its per-request cache run.
const currentMember = vi.hoisted(() => vi.fn(async (_chatId: string, _telegramUserId: string): Promise<boolean> => true));
const telegramCall = vi.hoisted(() => vi.fn(async (input: { body: { chat_id: string; user_id: number }; method: string }) => {
  const member = await currentMember(input.body.chat_id, String(input.body.user_id));
  return { body: { ok: true, result: { status: member ? "member" : "left", user: { id: input.body.user_id, is_bot: false } } }, ok: true };
}));
vi.mock("eve/channels/telegram", async (original) => ({ ...await original<object>(), callTelegramApi: telegramCall }));

import { closeDatabase, database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { sharedTaskRepository as tasks } from "../shared-task-repository.js";
import { createTaskFamilyFixture } from "../shared-task.integration-fixtures.js";
import { webAppApiDependencies } from "./web-app-api.js";
import { createWebAppGroupsApi } from "./web-app-groups-api.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

const TOKEN = "123456:web-app-groups-test";

function initData(telegramUserId: string): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ first_name: "Тест", id: Number(telegramUserId) }),
  };
  const check = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}

const inviteLink = vi.fn(async (_chatId: string): Promise<string | null> => "https://t.me/+join");
const dependencies = { ...webAppApiDependencies, botToken: () => TOKEN, botUsername: () => "osinara_bot", inviteLink };

(enabled ? describe : describe.skip)("Mini App «Группы» API", () => {
  let owner: MemoryAuthorization;
  let familyGroup: MemoryAuthorization;
  let dacha: string;
  let left: string;
  let foreign: string;
  const api = createWebAppGroupsApi({ ...dependencies, enabled: true });
  const headers = (who: string) => ({ authorization: `tma ${initData(who)}` });
  const list = (who: string, groups = api) => groups.list(new Request("https://x/app-api/groups", { headers: headers(who) }));
  const detail = (who: string, id: string, groups = api) =>
    groups.detail(new Request(`https://x/app-api/groups/${id}`, { headers: headers(who) }), { id });

  async function externalGroup(familyId: string, chatId: string, title: string): Promise<string> {
    return (await database().query<{ id: string }>(
      `INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, tool_allowlist, message_mode)
       VALUES($1,$2,$3,'external',$4,'all') RETURNING id`,
      [familyId, chatId, title, ["manage_shared_tasks", "remember", "search_memories", "list_memories"]])).rows[0]!.id;
  }

  beforeEach(async () => {
    ({ owner, familyGroup } = await createTaskFamilyFixture());
    currentMember.mockReset();
    currentMember.mockImplementation(async () => true);
    telegramCall.mockClear();
    dacha = await externalGroup(owner.familyId, "-104", "Дача");
    left = await externalGroup(owner.familyId, "-106", "Старый чат");
    const inDacha: MemoryAuthorization = { ...owner, groupId: dacha, scopes: ["group"] };
    await tasks.execute(inDacha, { action: "create", title: "Купить уголь" } as never, randomUUID());
    const ritual = (await tasks.execute(inDacha, { action: "create", kind: "ritual", title: "Шашлык по субботам" } as never, randomUUID())).task!;
    await tasks.execute(inDacha, { action: "record", id: ritual.id, note: "было", occurredOn: "2026-10-17" } as never, randomUUID());
    await tasks.execute({ ...owner, groupId: left, scopes: ["group"] }, { action: "create", title: "Секрет старого чата" } as never, randomUUID());
    await tasks.execute(familyGroup, { action: "create", title: "Семейное дело" } as never, randomUUID());
    await tasks.execute(owner, { action: "create", title: "Моё личное" } as never, randomUUID(), { visibility: "personal" });

    const other = (await database().query<{ id: string }>("INSERT INTO families(name) VALUES('Other') RETURNING id")).rows[0]!.id;
    const stranger = (await database().query<{ id: string }>(
      "INSERT INTO users(telegram_user_id, display_name) VALUES('700201','Чужой') RETURNING id")).rows[0]!.id;
    await database().query("INSERT INTO family_memberships(family_id, user_id, role) VALUES($1,$2,'owner')", [other, stranger]);
    foreign = await externalGroup(other, "-205", "Чужая группа");
    // Человек вышел из «Старого чата» (-106) после того, как дело там завели; в остальных состоит.
    currentMember.mockReset();
    currentMember.mockImplementation(async (chatId: string) => chatId !== "-106");
    telegramCall.mockClear();
  });
  afterAll(closeDatabase);

  it("answers 404 on both routes without the flag", async () => {
    const off = createWebAppGroupsApi({ ...dependencies, enabled: false });
    expect((await list("700101", off)).status).toBe(404);
    expect((await detail("700101", dacha, off)).status).toBe(404);
    expect(telegramCall).not.toHaveBeenCalled();
  });

  it("lists the family's groups the person is in now, with counts, and the link only for the owner", async () => {
    const mine = await list("700101");
    expect(mine.status).toBe(200);
    const body = await mine.json() as { createLink: string | null; groups: Array<Record<string, unknown>> };
    expect(body.createLink).toBe("https://t.me/osinara_bot?startgroup=group&admin=change_info+delete_messages+invite_users+pin_messages");
    expect(body.groups).toEqual([
      { id: familyGroup.groupId, kind: "family", more: false, openTasks: 1, title: "Family", traditions: 0, writable: false },
      { id: dacha, kind: "group", more: false, openTasks: 1, title: "Дача", traditions: 1, writable: true },
    ]);
    expect(body).toMatchObject({ partial: false });
    // Three groups of the family, one probe each: the repository's own recheck takes the same answer.
    expect(telegramCall).toHaveBeenCalledTimes(3);
    const member = await (await list("700102")).json() as { createLink: string | null; groups: unknown[] };
    expect(member.createLink).toBeNull();
    expect(member.groups).toHaveLength(2);
  });

  it("hides every group when Telegram cannot confirm membership", async () => {
    currentMember.mockImplementation(async () => { throw new Error("telegram down"); });
    expect(await (await list("700101")).json()).toMatchObject({ groups: [] });
    expect((await detail("700101", dacha)).status).toBe(404);
  });

  it("shows an external group's own tasks and traditions only, and a family group without anyone's personal", async () => {
    const group = await detail("700101", dacha);
    expect(group.status).toBe(200);
    expect(await group.json()).toEqual({
      canInvite: true, kind: "group", tasks: [{ actions: ["complete"], assignee: "Owner", due: null, id: expect.any(String), title: "Купить уголь", version: 1 }],
      participants: [], title: "Дача", traditions: [{ last: "2026-10-17", title: "Шашлык по субботам" }], truncated: false,
      writable: true,
    });
    expect(telegramCall).toHaveBeenCalledTimes(1);
    const family = await (await detail("700101", familyGroup.groupId!)).json() as {
      kind: string; participants: unknown[]; tasks: Array<{ title: string }>; writable: boolean;
    };
    expect(family.kind).toBe("family");
    expect(family).toMatchObject({ participants: [], writable: false });
    expect(family.tasks.map((task) => task.title)).toEqual(["Семейное дело"]);
  });

  it("answers 404 for a group the person left and for another family's group", async () => {
    expect((await detail("700101", left)).status).toBe(404);
    expect((await detail("700101", foreign)).status).toBe(404);
    expect((await detail("700201", dacha)).status).toBe(404);
    expect((await detail("700101", "not-a-uuid")).status).toBe(400);
    const strangerList = await (await list("700201")).json() as { groups: Array<{ title: string }> };
    expect(strangerList.groups.map((group) => group.title)).toEqual(["Чужая группа"]);
  });

  it("says more and truncated past five pages, and keeps traditions apart from a page full of ideas", async () => {
    await database().query(
      `INSERT INTO shared_tasks(family_id, group_id, scope, creator_telegram_id, assignee_telegram_id, title, status, kind)
       SELECT $1, $2, 'group', '700101', '700101', 'Идея ' || n, 'accepted', 'idea' FROM generate_series(1, 120) n`,
      [owner.familyId, dacha]);
    await database().query(
      `INSERT INTO shared_tasks(family_id, group_id, scope, creator_telegram_id, assignee_telegram_id, title, status)
       SELECT $1, $2, 'group', '700101', '700101', 'Дело ' || n, 'accepted' FROM generate_series(1, 500) n`,
      [owner.familyId, dacha]);
    const body = await (await list("700101")).json() as { groups: Array<{ id: string; more: boolean; openTasks: number; traditions: number }> };
    const group = body.groups.find((entry) => entry.id === dacha)!;
    expect(group.more).toBe(true);
    expect(group.traditions).toBe(1);
    expect(group.openTasks).toBeGreaterThan(300);
    const opened = await (await detail("700101", dacha)).json() as { tasks: unknown[]; traditions: Array<{ title: string }>; truncated: boolean };
    expect(opened.truncated).toBe(true);
    expect(opened.traditions.map((tradition) => tradition.title)).toEqual(["Шашлык по субботам"]);
  });

  const act = (who: string, id: string, task: string, action: string, body: Record<string, unknown>) =>
    api.task(new Request(`https://x/app-api/groups/${id}/tasks/${task}/${action}`, {
      body: JSON.stringify(body), headers: headers(who), method: "POST",
    }), { action, id, task });
  const invite = (who: string, id: string) =>
    api.invite(new Request(`https://x/app-api/groups/${id}/invite`, { body: "{}", headers: headers(who), method: "POST" }), { id });

  it("takes and closes a task of the group only, and only for a person in its chat now", async () => {
    const open = (await database().query<{ id: string }>(
      `INSERT INTO shared_tasks(family_id, group_id, scope, creator_telegram_id, title, status)
       VALUES($1, $2, 'group', '700101', 'Ничьё дело', 'open') RETURNING id`, [owner.familyId, dacha])).rows[0]!.id;
    const opened = await (await detail("700102", dacha)).json() as { tasks: Array<{ actions: string[]; id: string; title: string }> };
    expect(opened.tasks.find((task) => task.id === open)?.actions).toEqual(["claim", "complete"]);
    const taken = await act("700102", dacha, open, "claim", { nonce: "n-claim-1", version: 1 });
    expect(taken.status).toBe(200);
    const { task } = await taken.json() as { task: { version: number } };
    // The same nonce again is a replay of the same change, not a second one.
    expect((await act("700102", dacha, open, "claim", { nonce: "n-claim-1", version: 1 })).status).toBe(200);
    expect((await act("700102", dacha, open, "complete", { nonce: "n-done-1", version: task.version })).status).toBe(200);
    const state = await database().query<{ assignee_telegram_id: string; status: string }>(
      "SELECT status, assignee_telegram_id FROM shared_tasks WHERE id = $1", [open]);
    expect(state.rows[0]).toEqual({ assignee_telegram_id: "700102", status: "completed" });

    const family = (await database().query<{ id: string }>(
      "SELECT id FROM shared_tasks WHERE family_id = $1 AND title = 'Семейное дело'", [owner.familyId])).rows[0]!.id;
    expect((await act("700101", dacha, family, "complete", { nonce: "n-family", version: 1 })).status).toBe(404);
    const secret = (await database().query<{ id: string }>(
      "SELECT id FROM shared_tasks WHERE group_id = $1", [left])).rows[0]!.id;
    expect((await act("700101", left, secret, "complete", { nonce: "n-left-01", version: 1 })).status).toBe(404);
    expect((await act("700201", dacha, open, "complete", { nonce: "n-stranger", version: 1 })).status).toBe(404);
    expect((await act("700101", dacha, open, "cancel", { nonce: "n-cancel", version: 1 })).status).toBe(400);
  });

  const write = (who: string, id: string, body: Record<string, unknown>) =>
    api.create(new Request(`https://x/app-api/groups/${id}/tasks`, { body: JSON.stringify(body), headers: headers(who), method: "POST" }), { id });

  it("writes a tradition or a task into an ordinary group the person is in now, and nowhere else", async () => {
    const created = await write("700102", dacha, { kind: "ritual", nonce: "n-group-ritual", title: "Баня по воскресеньям" });
    expect(created.status).toBe(200);
    const { task } = await created.json() as { task: { id: string } };
    const row = await database().query<{ group_id: string; scope: string }>("SELECT scope, group_id FROM shared_tasks WHERE id = $1", [task.id]);
    expect(row.rows[0]).toEqual({ group_id: dacha, scope: "group" });
    const opened = await (await detail("700102", dacha)).json() as { traditions: Array<{ title: string }> };
    expect(opened.traditions.map((item) => item.title)).toContain("Баня по воскресеньям");
    // The same nonce is a replay, not a second tradition.
    expect((await write("700102", dacha, { kind: "ritual", nonce: "n-group-ritual", title: "Баня по воскресеньям" })).status).toBe(200);
    expect((await database().query("SELECT 1 FROM shared_tasks WHERE title = 'Баня по воскресеньям'")).rowCount).toBe(1);

    expect((await write("700101", dacha, { nonce: "n-group-task", title: "Купить дрова" })).status).toBe(200);
    expect((await write("700101", familyGroup.groupId!, { nonce: "n-family-grp", title: "Не сюда" })).status).toBe(404);
    expect((await write("700101", left, { nonce: "n-left-grp1", title: "Не сюда" })).status).toBe(404);
    expect((await write("700201", dacha, { nonce: "n-stranger1", title: "Не сюда" })).status).toBe(404);
    expect((await write("700101", dacha, { kind: "ritual", dueOn: "2026-10-21", nonce: "n-due-ritual", title: "Со сроком" })).status).toBe(400);
    expect((await write("700101", dacha, { dueOn: "21.10", nonce: "n-due-bad01", title: "Со сроком" })).status).toBe(400);
    expect((await write("700101", dacha, { nonce: "n-both-bad1", title: "Кому?", unassigned: true, assigneeRef: dacha })).status).toBe(400);
    expect((await write("700101", dacha, { kind: "project", nonce: "n-kind-bad1", title: "Не тот вид" })).status).toBe(400);
  });

  it("gives a group's task a day and a person of its chat, or leaves it for whoever takes it", async () => {
    const people = await database().query<{ id: string; telegram_user_id: string }>(
      `INSERT INTO shared_task_participants(family_id, group_id, telegram_user_id, display_name)
       VALUES ($1, $2, '700101', 'Owner'), ($1, $2, '700102', 'Member') RETURNING id, telegram_user_id`, [owner.familyId, dacha]);
    const refOf = (who: string) => people.rows.find((row) => row.telegram_user_id === who)!.id;
    const opened = await (await detail("700101", dacha)).json() as { participants: Array<{ me: boolean; name: string; ref: string }> };
    expect(opened.participants).toEqual([
      { me: false, name: "Member", ref: refOf("700102") }, { me: true, name: "Owner", ref: refOf("700101") },
    ]);
    const today = await webAppApiDependencies.today(owner);
    const row = async (response: Response) => {
      expect(response.status).toBe(200);
      const { task } = await response.json() as { task: { id: string } };
      return (await database().query<{ assignee_telegram_id: string | null; due_on: string | null; status: string }>(
        "SELECT assignee_telegram_id, due_on::text AS due_on, status FROM shared_tasks WHERE id = $1", [task.id])).rows[0];
    };
    expect(await row(await write("700101", dacha, { dueOn: today, nonce: "n-grp-free1", title: "Наколоть дров", unassigned: true })))
      .toEqual({ assignee_telegram_id: null, due_on: today, status: "open" });
    expect(await row(await write("700101", dacha, { assigneeRef: refOf("700102"), nonce: "n-grp-ask01", title: "Привезти уголь" })))
      .toEqual({ assignee_telegram_id: "700102", due_on: null, status: "proposed" });
    // Someone who has left the chat is not given anything.
    currentMember.mockImplementation(async (_chat: string, user: string) => user !== "700102");
    expect((await write("700101", dacha, { assigneeRef: refOf("700102"), nonce: "n-grp-gone1", title: "Не ему" })).status).toBe(403);
  });

  it("issues an invite link to the owner of an ordinary group only", async () => {
    const issued = await invite("700101", dacha);
    expect(issued.status).toBe(200);
    expect(await issued.json()).toEqual({ link: "https://t.me/+join" });
    expect(inviteLink).toHaveBeenCalledWith("-104");
    expect((await invite("700102", dacha)).status).toBe(404);
    expect((await invite("700101", familyGroup.groupId!)).status).toBe(404);
    expect((await invite("700101", left)).status).toBe(404);
    inviteLink.mockResolvedValueOnce(null);
    const refused = await invite("700101", dacha);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: "AGENT_WEB_APP_GROUP_NO_INVITE_RIGHT" });
  });

  it("leaves out a group that does not answer by the deadline and marks the list partial", async () => {
    currentMember.mockImplementation(async (chatId: string) => chatId === "-104" ? new Promise<boolean>(() => undefined) : true);
    const hurried = createWebAppGroupsApi({ ...dependencies, enabled: true, listDeadlineMs: 300 });
    const body = await (await list("700101", hurried)).json() as { groups: Array<{ title: string }>; partial: boolean };
    expect(body.partial).toBe(true);
    expect(body.groups.map((group) => group.title)).toEqual(["Family", "Старый чат"]);
  });
});
