/**
 * Task buttons on the real schema (migration 179): a press changes the task through the task
 * repository under the presser's live rights, without the model.
 *
 * Constructs covered:
 * - «✓ дело» in a private chat closes the task, the button turns into «↩ Вернуть», and that one opens
 *   it again; a second tap on the same button is a replay, not a second change.
 * - Refusals: another person pressing a private button, a button pressed in another chat, a person of
 *   another family in the family group, an expired button.
 * - The repository still decides rights: a family member cannot close a task assigned to another.
 * - A button whose task changed since is refused as stale and disappears from the keyboard.
 * - «Беру» under a request accepts it and takes «Не могу» away; «Не могу» declines.
 * - «Беру» under an unowned task in the family group: the first press wins, the second hears it is taken.
 * - The overview settings buttons change only the presser's own hour and switch.
 * - The morning overview keyboard: one «✓ дело» per shown task, then «Все дела · N»; its first button
 *   closes that task. «Доска» (Mini App) survives the redraw, and so does «Открыть доску» under a receipt.
 * - «В «группа»» moves a personal record into an ordinary group only while the presser is in its chat; every button
 *   of that record goes; a replay changes nothing; a family record and a group of another kind are refused.
 */
import type { TelegramCallbackQuery } from "eve/channels/telegram";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const currentMember = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../telegram-current-membership.js", () => ({
  isCurrentTelegramMember: currentMember, withTelegramMembershipCache: (work: () => unknown) => work(),
}));

import { sharedTaskVisibility } from "../shared-task-visibility.js";
import { closeDatabase, database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { sharedTaskRepository as tasks } from "../shared-task-repository.js";
import { projectRepository } from "../projects/project-repository.js";
import { createTaskFamilyFixture, makeTask } from "../shared-task.integration-fixtures.js";
import { authorizeTaskButtonPress, productionTaskButtonAuthorizer } from "./task-button-authorization.js";
import { staleTaskPressDependencies } from "./stale-task-press.js";
import { myTasksDependencies } from "./my-tasks-press.js";
import { boardRedrawDependencies } from "./board-buttons.js";
import { productionCompleteProject } from "./board-presses.js";
import { coachTouchPressDependencies } from "./coach-touch-press.js";
import { questPressDependencies } from "./quest-press.js";
import { createTaskButtonCallbackHandler } from "./task-button-callback.js";
import { taskButtonCallbackData } from "./task-button-callback-data.js";
import { receiptUndoKeyboard } from "./receipt-undo.js";
import type { InlineKeyboard } from "./task-button-keyboard.js";
import { dailyOverviewSettings } from "./digest-settings.js";
import { overviewKeyboard } from "./overview-keyboard.js";
import { requestKeyboard, unownedKeyboard } from "./request-keyboards.js";
import { liveGroupsOf, toGroupDependencies } from "./receipt-to-group.js";
import { taskButtonRepository, type TaskButtonItem } from "./task-button-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

const GROUP_CHAT = "-103";
/** The morning keyboard also has «Доска» (a web_app button); the task buttons are callback ones. */
const callbackOf = (button: unknown) => (button as { callback_data: string }).callback_data;

(enabled ? describe : describe.skip)("task buttons", () => {
  let owner: MemoryAuthorization;
  let member: MemoryAuthorization;
  let familyGroup: MemoryAuthorization;
  const answers: Array<{ showAlert: boolean; text: string }> = [];
  const edits: InlineKeyboard[] = [];
  const texts: string[] = [];
  const boards: string[] = [];
  const answeredBy: string[] = [];
  const ephemeral: Array<{ callbackQueryId: string; chatId: string; receiverId: string; text: string }> = [];
  const boardEdits: string[] = [];

  const handler = createTaskButtonCallbackHandler({
    ...toGroupDependencies,
    stale: { ...staleTaskPressDependencies, timezone: async () => "Europe/Moscow" },
    myTasks: {
      ...myTasksDependencies,
      async sendEphemeral(input) { ephemeral.push(input); },
      async sendEphemeralRich(input) { ephemeral.push({ ...input, text: input.markdown }); },
    },
    boardRedraw: { ...boardRedrawDependencies, async edit(input) { boardEdits.push(input.markdown); } },
    completeProject: productionCompleteProject,
    coachTouch: { ...coachTouchPressDependencies, async send() { return "1"; } },
    quest: { ...questPressDependencies, async send() { return "1"; } },
    async answer(input) { answers.push({ showAlert: input.showAlert, text: input.text }); },
    async changeVisibility(auth, input, operationKey) {
      const { task } = await sharedTaskVisibility.change(auth, input, operationKey);
      return { id: task.id, title: task.title, version: task.version };
    },
    setDefaultVisibility: (auth, visibility, pressedId, buttonIds) => taskButtonRepository.answerDefaultChoice({
      familyId: auth.familyId, ids: buttonIds, now: new Date(), pressedId, userId: auth.userId!, visibility,
    }),
    authorize: (row, press) => authorizeTaskButtonPress(row, press, productionTaskButtonAuthorizer),
    claimDispatch: (row, queryId) => taskButtonRepository.claimDispatch(row.id, queryId),
    createButtons: (row, items) => taskButtonRepository.create({
      chatId: row.chatId, familyId: row.familyId, items, now: new Date(), recipientTelegramId: row.recipientTelegramId,
    }),
    async editKeyboard(input) { edits.push(input.keyboard); },
    async editText(input) { edits.push(input.keyboard); texts.push(input.text); },
    claimed: (ids) => taskButtonRepository.claimed(ids),
    async execute(auth, input, operationKey) {
      const result = await tasks.execute(auth, input as never, operationKey) as unknown as { replayed: boolean; task: object };
      return { ...result.task, replayed: result.replayed } as never;
    },
    find: (id) => taskButtonRepository.find(id, new Date()),
    markInitiativeAnswered: async (userId) => { answeredBy.push(userId); },
    markAnswered: (row) => taskButtonRepository.markAnswersRemoved({ chatId: row.chatId, id: row.id, taskId: row.taskId! }, new Date()),
    markRemoved: (row) => taskButtonRepository.markRemoved(row.id, new Date()),
    markReplaced: (row, replacementId) => taskButtonRepository.markReplaced(row.id, replacementId),
    resolve: (ids) => taskButtonRepository.resolve(ids),
    async showAllTasks() { boards.push("board"); },
    async openDigestSettings() { boards.push("settings"); },
    async changeDigest(auth, setting) {
      await dailyOverviewSettings.write({ familyId: auth.familyId, setting, userId: auth.userId! });
    },
  });

  async function button(input: {
    chatId: string; item: TaskButtonItem; now?: Date; recipient: string | null;
  }): Promise<string> {
    const [id] = await taskButtonRepository.create({
      chatId: input.chatId, familyId: owner.familyId, items: [input.item],
      now: input.now ?? new Date(), recipientTelegramId: input.recipient,
    });
    return taskButtonCallbackData(id!);
  }

  function press(
    data: string, presser: string, chat: { id: string; type: "group" | "private" | "supergroup" },
    keyboard: InlineKeyboard = [[{ callback_data: data, text: "✓ дело" }], [{ callback_data: "other", text: "Другое" }]],
    queryId = `q-${Math.random()}`,
    text?: string,
    entities?: unknown[],
  ): Promise<boolean> {
    const query: TelegramCallbackQuery = {
      data,
      from: { id: presser, isBot: false },
      id: queryId,
      message: { chat, messageId: "77" },
      raw: { message: {
        reply_markup: { inline_keyboard: keyboard }, ...(text === undefined ? {} : { text }), ...(entities ? { entities } : {}),
      } },
    };
    return handler(query);
  }

  const status = async (id: string) =>
    (await database().query<{ status: string }>("SELECT status FROM shared_tasks WHERE id=$1", [id])).rows[0]!.status;

  beforeEach(async () => {
    currentMember.mockResolvedValue(true);
    ({ owner, member, familyGroup } = await createTaskFamilyFixture());
    answers.length = 0;
    edits.length = 0;
    texts.length = 0;
    boards.length = 0;
    answeredBy.length = 0;
  });
  afterAll(closeDatabase);

  it("closes a task from a private chat, offers undo, and replays a second tap", async () => {
    const task = await makeTask(owner, "Подготовить видео");
    const ownerChat = { id: "700101", type: "private" as const };
    const data = await button({ chatId: "700101", item: { action: "complete", task: { id: task.id, version: task.version } }, recipient: "700101" });

    await expect(press(data, "700101", ownerChat)).resolves.toBe(true);
    expect(await status(task.id)).toBe("completed");
    expect(answers.at(-1)).toEqual({ showAlert: false, text: "✓ Закрыто: Подготовить видео" });
    const undo = edits.at(-1)![0]![0]!;
    expect(undo.text).toBe("↩ Вернуть · Подготовить видео");
    expect(edits.at(-1)![1]).toEqual([{ callback_data: "other", text: "Другое" }]);

    await press(data, "700101", ownerChat);
    expect(await status(task.id)).toBe("completed");
    expect(answers.at(-1)!.showAlert).toBe(false);
    expect(edits.at(-1)![0]![0]).toEqual(undo);

    await press(undo.callback_data!, "700101", ownerChat);
    expect(await status(task.id)).toBe("accepted");
    expect(answers.at(-1)!.text).toBe("↩ Вернул: Подготовить видео");
    expect(edits.at(-1)![0]![0]!.text).toBe("✓ Подготовить видео");

    // The first «✓» pressed again after the undo: its replay must not claim the task is closed.
    await press(data, "700101", ownerChat);
    expect(await status(task.id)).toBe("accepted");
    expect(answers.at(-1)).toEqual({
      showAlert: true, text: "Это дело уже изменили. Скажи «покажи дела», чтобы увидеть, как оно сейчас.",
    });
  });

  it("answers the message about a stuck task once: a week later, cancel or keep, and the buttons go", async () => {
    const ownerChat = { id: "700101", type: "private" as const };
    const ask = "«Договориться о встрече» не менялось с 15 сентября. Что с ним сделаем?";
    const stale = async (title: string, action: "cancel" | "keep" | "postpone_week") => {
      const task = await makeTask(owner, title);
      const data = await button({ chatId: "700101", item: { action, task: { id: task.id, version: task.version } }, recipient: "700101" });
      await press(data, "700101", ownerChat, [[{ callback_data: data, text: "x" }]], undefined, ask);
      return task;
    };

    const later = await stale("Позвонить мастеру", "postpone_week");
    const moved = (await database().query<{ due_on: string; version: number }>(
      "SELECT due_on::text, version FROM shared_tasks WHERE id=$1", [later.id])).rows[0]!;
    const inWeek = new Date(Date.now() + 7 * 86_400_000);
    expect(moved.due_on).toBe(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(inWeek));
    expect(answers.at(-1)!.text).toMatch(/^Перенесено на .+: Позвонить мастеру$/u);
    // The question is answered: the text gets the outcome line, and no button is left.
    expect(texts.at(-1)).toBe(`${ask}\n\n${answers.at(-1)!.text}`);
    expect(edits.at(-1)).toEqual([]);

    const dropped = await stale("Ремонт полки", "cancel");
    expect(await status(dropped.id)).toBe("cancelled");
    expect(answers.at(-1)!.text).toBe("Снято: Ремонт полки");

    const kept = await stale("Разобрать шкаф", "keep");
    expect(await status(kept.id)).toBe("accepted");
    const rest = await database().query("SELECT 1 FROM task_overview_rests WHERE task_id=$1 AND task_version=$2", [kept.id, kept.version]);
    expect(rest.rowCount).toBe(1);
    expect(answers.at(-1)!.text).toBe("Оставлено как есть: Разобрать шкаф. В сводке появится, когда дело изменится.");
  });

  it("moves a personal record into an ordinary group whose chat the person is in, once", async () => {
    const flat = (await database().query<{ id: string }>(
      `INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, tool_allowlist, message_mode)
       VALUES($1, '-4001', 'Квартира', 'external', '{manage_shared_tasks}', 'all') RETURNING id`, [owner.familyId])).rows[0]!.id;
    await database().query(
      `INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, tool_allowlist, message_mode)
       VALUES($1, '-4002', 'Без дел', 'external', '{}', 'all')`, [owner.familyId]);
    const task = await makeTask(owner, "Передать показания");
    // Offered: only the group that keeps tasks, and only for a fresh personal record without details.
    expect(await liveGroupsOf(owner.familyId, "700101", task.id)).toEqual([{ id: flat, title: "Квартира" }]);
    const detailed = (await tasks.execute(owner, { action: "create", details: "от давления", title: "Таблетки" } as never, `d-${Math.random()}`)).task!;
    expect(await liveGroupsOf(owner.familyId, "700101", detailed.id)).toEqual([]);
    const ownerChat = { id: "700101", type: "private" as const };
    const item = { action: "to_group" as const, groupId: flat, task: { id: task.id, version: task.version } };
    const share = await button({ chatId: "700101", item: { action: "share", task: { id: task.id, version: task.version } }, recipient: "700101" });
    const move = await button({ chatId: "700101", item, recipient: "700101" });
    const keyboard = [[{ callback_data: share, text: "Сделать общим · Передать показания" }],
      [{ callback_data: move, text: "В «Квартира» · Передать показания" }]];
    const where = async () => (await database().query<{ group_id: string | null; scope: string }>(
      "SELECT scope, group_id FROM shared_tasks WHERE id=$1", [task.id])).rows[0]!;

    // Not in the chat now: nothing moves.
    currentMember.mockResolvedValueOnce(false);
    await press(move, "700101", ownerChat, keyboard);
    expect(await where()).toEqual({ group_id: null, scope: "personal" });
    expect(answers.at(-1)!.showAlert).toBe(true);

    await press(move, "700101", ownerChat, keyboard);
    expect(await where()).toEqual({ group_id: flat, scope: "group" });
    expect(answers.at(-1)).toEqual({ showAlert: false, text: "Теперь в группе «Квартира»: Передать показания" });
    // Both buttons of the record go: it is no longer the private chat's to share.
    expect(edits.at(-1)).toEqual([]);
    await press(move, "700101", ownerChat, keyboard);
    expect(await where()).toEqual({ group_id: flat, scope: "group" });

    // A family record is not moved, and a family group is not a target.
    const shared = await makeTask(familyGroup, "Семейное");
    const fromFamily = await button({ chatId: "700101", item: { action: "to_group", groupId: flat, task: { id: shared.id, version: shared.version } }, recipient: "700101" });
    await press(fromFamily, "700101", ownerChat);
    expect((await database().query<{ scope: string }>("SELECT scope FROM shared_tasks WHERE id=$1", [shared.id])).rows[0]!.scope).toBe("family");
    const other = await makeTask(owner, "Личное");
    const toFamilyGroup = await button({ chatId: "700101", item: { action: "to_group", groupId: familyGroup.groupId!, task: { id: other.id, version: other.version } }, recipient: "700101" });
    await press(toFamilyGroup, "700101", ownerChat);
    expect((await database().query<{ scope: string }>("SELECT scope FROM shared_tasks WHERE id=$1", [other.id])).rows[0]!.scope).toBe("personal");
  });

  it("makes a new task shared and back from its receipt, and answers the default question once", async () => {
    const task = await makeTask(owner, "Купить шины");
    const ownerChat = { id: "700101", type: "private" as const };
    const share = await button({ chatId: "700101", item: { action: "share", task: { id: task.id, version: task.version } }, recipient: "700101" });
    await press(share, "700101", ownerChat);
    const scope = async () => (await database().query<{ scope: string }>("SELECT scope FROM shared_tasks WHERE id=$1", [task.id])).rows[0]!.scope;
    expect(await scope()).toBe("family");
    expect(answers.at(-1)).toEqual({ showAlert: false, text: "Теперь видят все в семье: Купить шины" });
    const unshare = edits.at(-1)![0]![0]!;
    expect(unshare.text).toBe("Сделать личным · Купить шины");
    await press(unshare.callback_data!, "700101", ownerChat);
    expect(await scope()).toBe("personal");

    const family = await button({ chatId: "700101", item: { action: "default_family" }, recipient: "700101" });
    const personal = await button({ chatId: "700101", item: { action: "default_personal" }, recipient: "700101" });
    await press(family, "700101", ownerChat, [[{ callback_data: family, text: "Новые дела: для семьи" }, { callback_data: personal, text: "Только мне" }]]);
    const stored = await database().query<{ default_task_visibility: string }>(
      "SELECT default_task_visibility FROM user_notification_settings WHERE user_id = $1", [owner.userId]);
    expect(stored.rows[0]!.default_task_visibility).toBe("family");
    // Both buttons of the question go away, and an old «Только мне» replayed later changes nothing.
    expect(edits.at(-1)).toEqual([]);
    await press(personal, "700101", ownerChat);
    const again = await database().query<{ default_task_visibility: string }>(
      "SELECT default_task_visibility FROM user_notification_settings WHERE user_id = $1", [owner.userId]);
    expect(again.rows[0]!.default_task_visibility).toBe("family");
  });

  it("keeps the first undo when two buttons are pressed before either redraw", async () => {
    const first = await makeTask(owner, "Купить хлеб");
    const second = await makeTask(owner, "Забрать заказ");
    const markup = await overviewKeyboard({
      familyId: owner.familyId, now: new Date(), openCount: 2, telegramUserId: "700101",
      shown: [first, second].map((task) => ({ ...task, dueAt: null, dueOn: null, kind: "task", listName: null, source: "Личное" })),
    });
    const original = markup.inline_keyboard;
    const chat = { id: "700101", type: "private" as const };
    await press(callbackOf(original[0]![0]!), "700101", chat, original);
    await press(callbackOf(original[0]![1]!), "700101", chat, original);
    expect(edits.at(-1)!.map((row) => row.map((button) => button.text)))
      .toEqual([["↩ Вернуть · Купить хлеб", "↩ Вернуть · Забрать заказ"], ["Все дела · 2"], ["Время сводки"]]);
  });

  it("keeps «Доска» (the Mini App) next to «Сводка» when a task button redraws the keyboard", async () => {
    const task = await makeTask(owner, "Купить хлеб");
    const markup = await overviewKeyboard({
      familyId: owner.familyId, now: new Date(), openCount: 1, telegramUserId: "700101", webAppUrl: "https://h/app/",
      shown: [{ ...task, dueAt: null, dueOn: null, kind: "task", listName: null, source: "Личное" }],
    });
    expect(markup.inline_keyboard.at(-1)!.at(-1)).toEqual({ text: "Доска", web_app: { url: "https://h/app/" } });
    await press(callbackOf(markup.inline_keyboard[0]![0]), "700101", { id: "700101", type: "private" }, markup.inline_keyboard);
    expect(edits.at(-1)!.at(-1)!.at(-1)).toEqual({ text: "Доска", web_app: { url: "https://h/app/" } });
  });

  it("keeps «Открыть доску» under a receipt when its «↩ Вернуть» is pressed", async () => {
    const task = await makeTask(owner, "Купить хлеб");
    const closed = (await tasks.execute(owner, { action: "complete", id: task.id, version: task.version } as never, "close")).task!;
    const [id] = await taskButtonRepository.create({
      chatId: "700101", familyId: owner.familyId, items: [{ action: "reopen", task: { id: task.id, version: closed.version } }],
      now: new Date(), recipientTelegramId: "700101",
    });
    const keyboard = receiptUndoKeyboard([{ id: task.id, title: task.title, version: closed.version }], [id!], "https://h/app/");
    await press(callbackOf(keyboard[0]![0]), "700101", { id: "700101", type: "private" }, keyboard);
    expect(await status(task.id)).toBe("accepted");
    expect(edits.at(-1)).toEqual([[{ callback_data: edits.at(-1)![0]![0]!.callback_data, text: "✓ Купить хлеб" }],
      [{ text: "Открыть доску", web_app: { url: "https://h/app/" } }]]);
  });

  it("sends «Все дела» once per press, also when the same update is replayed", async () => {
    const data = await button({ chatId: "700101", item: { action: "all_tasks" }, recipient: "700101" });
    const chat = { id: "700101", type: "private" as const };
    await press(data, "700101", chat, undefined, "query-1");
    await press(data, "700101", chat, undefined, "query-1");
    await press(data, "700101", chat, undefined, "query-2");
    expect(boards).toHaveLength(2);
  });

  it("refuses another person, another chat, another family and an expired button", async () => {
    const task = await makeTask(owner, "Подобрать страховку");
    const item: TaskButtonItem = { action: "complete", task: { id: task.id, version: task.version } };
    const data = await button({ chatId: "700101", item, recipient: "700101" });

    await press(data, "700102", { id: "700101", type: "private" });
    expect(answers.at(-1)).toEqual({ showAlert: true, text: "Эта кнопка для другого человека." });
    await press(data, "700101", { id: "-555", type: "supergroup" });
    expect(answers.at(-1)!.text).toBe("Эта кнопка работает только в том чате, куда я её прислал.");

    const stranger = await database().query<{ id: string }>("INSERT INTO families(name) VALUES('Чужие') RETURNING id");
    const user = await database().query<{ id: string }>(
      "INSERT INTO users(telegram_user_id,display_name) VALUES('700201','Чужой') RETURNING id");
    await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')",
      [stranger.rows[0]!.id, user.rows[0]!.id]);
    const groupData = await button({ chatId: GROUP_CHAT, item, recipient: null });
    await press(groupData, "700201", { id: GROUP_CHAT, type: "supergroup" });
    expect(answers.at(-1)!.text).toBe("Дела семьи доступны только её участникам.");

    const old = await button({ chatId: "700101", item, now: new Date(Date.now() - 8 * 86_400_000), recipient: "700101" });
    await press(old, "700101", { id: "700101", type: "private" });
    expect(answers.at(-1)!.text).toBe("Кнопка устарела. Скажи словами, что сделать с делом.");
    expect(await status(task.id)).toBe("accepted");
  });

  it("closes a task from «✓» inside the rich board and redraws the board with it struck on top and its undo", async () => {
    const task = await makeTask(owner, "Купить хлеб");
    const data = await button({ chatId: "700101", item: { action: "complete", task: { id: task.id, version: task.version } }, recipient: "700101" });
    boardEdits.length = 0;
    const query: TelegramCallbackQuery = {
      data, from: { id: "700101", isBot: false }, id: "q-board",
      message: { chat: { id: "700101", type: "private" }, messageId: "91" },
      raw: { message: { message_id: 91, rich_message: { blocks: [{ buttons: [{ callback_data: data, text: { text: "✓ Купить хлеб" } }], type: "buttons" }] } } },
    };

    await handler(query);

    expect(await status(task.id)).toBe("completed");
    expect(boardEdits).toHaveLength(1);
    expect(boardEdits[0]).toContain("**Только что закрыто · 1**");
    expect(boardEdits[0]).toContain("- ✓ ~~Купить хлеб~~");
    expect(boardEdits[0]).toContain("↩ Вернуть · Купить хлеб");
  });

  it("redraws a filtered board as the same filtered board after a press", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const due = await tasks.execute(owner, { action: "create", dueOn: today, title: "Купить молоко" } as never, "board-today-1");
    await makeTask(owner, "Без срока");
    const data = await button({ chatId: "700101", recipient: "700101",
      item: { action: "complete", boardQuery: { filters: { view: "today" }, source: "list" }, task: { id: due.task!.id, version: due.task!.version } } });
    boardEdits.length = 0;
    await handler({
      data, from: { id: "700101", isBot: false }, id: "q-today",
      message: { chat: { id: "700101", type: "private" }, messageId: "93" },
      raw: { message: { message_id: 93, rich_message: { blocks: [{ buttons: [{ callback_data: data, text: { text: "✓ Купить молоко" } }], type: "buttons" }] } } },
    });

    expect(boardEdits).toHaveLength(1);
    expect(boardEdits[0]).toContain("~~Купить молоко~~");
    // «на сегодня» осталось «на сегодня»: дело без срока на перерисованной доске не появилось.
    expect(boardEdits[0]).not.toContain("Без срока");
  });

  it("finishes a project whose tasks are all done from «Завершить» inside the board, and redraws it", async () => {
    const created = await projectRepository.execute(owner, { action: "create", nextStep: { title: "Купить шланг" }, title: "Дача" } as never, "proj-dacha");
    const step = created.nextStep!;
    const stepRow = (await database().query<{ version: number }>("SELECT version FROM shared_tasks WHERE id=$1", [step.id])).rows[0]!;
    await tasks.execute(owner, { action: "complete", id: step.id, version: stepRow.version } as never, "proj-step-done");
    const project = (await projectRepository.execute(owner, { action: "list" } as never)).projects!.find((item) => item.title === "Дача")!;
    const data = await button({ chatId: "700101", item: { action: "project_complete", task: { id: project.id, version: project.version } }, recipient: "700101" });
    boardEdits.length = 0;
    const query: TelegramCallbackQuery = {
      data, from: { id: "700101", isBot: false }, id: "q-proj",
      message: { chat: { id: "700101", type: "private" }, messageId: "92" },
      raw: { message: { message_id: 92, rich_message: { blocks: [{ buttons: [{ callback_data: data, text: { text: "Завершить · Дача" } }], type: "buttons" }] } } },
    };

    await handler(query);

    expect(answers.at(-1)).toEqual({ showAlert: false, text: "Проект завершён: Дача" });
    expect(await status(project.id)).toBe("completed");
  });

  it("shows «Мои дела» in the family group only to the presser and only with their family tasks", async () => {
    await tasks.execute(familyGroup, { action: "create", title: "Вынести мусор" } as never, "group-mine");
    await makeTask(owner, "Записаться к врачу");
    ephemeral.length = 0;
    const data = await button({ chatId: GROUP_CHAT, item: { action: "my_tasks" }, recipient: null });

    await press(data, "700101", { id: GROUP_CHAT, type: "supergroup" }, undefined, "q-mine");

    expect(ephemeral).toHaveLength(1);
    expect(ephemeral[0]).toMatchObject({ callbackQueryId: "q-mine", chatId: GROUP_CHAT, receiverId: "700101" });
    expect(ephemeral[0]!.text).toContain("• Вынести мусор");
    // A family group carries only the family scope: the personal task never reaches the group, even for one.
    expect(ephemeral[0]!.text).not.toContain("Записаться к врачу");
    expect(ephemeral[0]!.text).toContain("Личные дела — в личке со мной.");
    expect(answers.at(-1)).toEqual({ showAlert: false, text: "" });
  });

  it("shows «Все дела» in the family group as the family board, only to the presser and without personal tasks", async () => {
    await tasks.execute(familyGroup, { action: "create", title: "Вынести мусор" } as never, "group-all");
    await makeTask(owner, "Записаться к врачу");
    ephemeral.length = 0;
    const data = await button({ chatId: GROUP_CHAT, item: { action: "all_tasks" }, recipient: null });

    await press(data, "700102", { id: GROUP_CHAT, type: "supergroup" }, undefined, "q-all");

    expect(ephemeral).toHaveLength(1);
    expect(ephemeral[0]).toMatchObject({ callbackQueryId: "q-all", chatId: GROUP_CHAT, receiverId: "700102" });
    expect(ephemeral[0]!.text).toContain("Вынести мусор");
    expect(ephemeral[0]!.text).not.toContain("Записаться к врачу");
    expect(answers.at(-1)).toEqual({ showAlert: false, text: "" });
  });

  it("leaves rights to the task repository in the family group", async () => {
    const task = (await tasks.execute(familyGroup, {
      action: "create", title: "Вынести мусор", assigneeRef: undefined,
    } as never, "group-create")).task!;
    const data = await button({ chatId: GROUP_CHAT, item: { action: "complete", task: { id: task.id, version: task.version } }, recipient: null });

    // The author's own task: the second member may not close it for them.
    await press(data, "700102", { id: GROUP_CHAT, type: "supergroup" });
    expect(answers.at(-1)!.showAlert).toBe(true);
    expect(await status(task.id)).not.toBe("completed");

    await press(data, "700101", { id: GROUP_CHAT, type: "supergroup" });
    expect(await status(task.id)).toBe("completed");
    expect(member.familyId).toBe(owner.familyId);
  });

  it("builds the morning overview keyboard whose buttons close the shown tasks", async () => {
    const first = await makeTask(owner, "Купить хлеб");
    const second = await makeTask(owner, "Забрать заказ");
    const markup = await overviewKeyboard({
      familyId: owner.familyId, now: new Date(), openCount: 7,
      shown: [{ ...first, dueAt: null, dueOn: null, kind: "task", listName: null, source: "Личное" }, { ...second, kind: "task", listName: null, source: "Личное", dueAt: null, dueOn: null }],
      telegramUserId: "700101",
    });
    expect(markup.inline_keyboard.map((row) => row.map((button) => button.text)))
      .toEqual([["✓ Купить хлеб", "✓ Забрать заказ"], ["Все дела · 7"], ["Время сводки"]]);

    const text = "Доброе утро.\n\nСегодня · 2\n• Купить хлеб\n• Забрать заказ";
    const bold = [{ length: 12, offset: 0, type: "bold" }, { length: 11, offset: 14, type: "bold" }];
    const ownerChat = { id: "700101", type: "private" as const };
    await press(callbackOf(markup.inline_keyboard[0]![0]!), "700101", ownerChat, markup.inline_keyboard, undefined, text, bold);
    expect(await status(first.id)).toBe("completed");
    expect(await status(second.id)).toBe("accepted");
    // The same message, its closed line struck in place and the bold headers kept.
    const struck = "Доброе утро.\n\nСегодня · 2\n✓ Купить хлеб\n• Забрать заказ";
    expect(texts).toEqual([struck]);
    expect(edits.at(-1)!.flat().map((button) => button.text)).toEqual(["↩ Вернуть · Купить хлеб", "✓ Забрать заказ", "Все дела · 7", "Время сводки"]);

    // «Вернуть» on the edited message brings the line back as it was.
    const undo = edits.at(-1)![0]![0]!.callback_data!;
    await press(undo, "700101", ownerChat, edits.at(-1)!, undefined, struck,
      [...bold, { length: 10, offset: struck.indexOf("Купить"), type: "strikethrough" }]);
    expect(await status(first.id)).toBe("accepted");
    expect(texts.at(-1)).toBe(text);
  });

  it("marks a repeated task done in the overview, though it gets no «Вернуть»", async () => {
    const flowers = (await tasks.execute(owner, {
      action: "create", dueOn: "2026-10-17", repeat: { interval: 1, unit: "weekly" }, title: "Полить цветы",
    } as never, "create-flowers")).task!;
    const markup = await overviewKeyboard({
      familyId: owner.familyId, now: new Date(), openCount: 1,
      shown: [{ ...flowers, dueAt: null, kind: "task", listName: null, source: "Личное" }], telegramUserId: "700101",
    });
    const text = "Доброе утро.\n\nСегодня · 1\n• 🔁 Полить цветы";
    await press(callbackOf(markup.inline_keyboard[0]![0]!), "700101", { id: "700101", type: "private" },
      markup.inline_keyboard, undefined, text, [{ length: 12, offset: 0, type: "bold" }]);
    expect(texts).toEqual(["Доброе утро.\n\nСегодня · 1\n✓ 🔁 Полить цветы"]);
    expect(edits.at(-1)!.flat().map((button) => button.text)).toEqual(["Все дела · 1", "Время сводки"]);
  });

  async function familyTask(title: string, status: "open" | "proposed", assignee: string | null) {
    const task = (await tasks.execute(familyGroup, { action: "create", title } as never, `create-${title}`)).task!;
    await database().query(
      "UPDATE shared_tasks SET status=$2, assignee_telegram_id=$3, version=version+1 WHERE id=$1", [task.id, status, assignee]);
    return { id: task.id, title, version: task.version + 1 };
  }

  it("accepts a request with «Беру», which takes «Не могу» away, and declines with «Не могу»", async () => {
    const parcel = await familyTask("Забрать посылку", "proposed", "700102");
    const markup = (await requestKeyboard({ familyId: owner.familyId, now: new Date(), tasks: [parcel], telegramUserId: "700102" }))!;
    expect(markup.inline_keyboard.map((row) => row.map((button) => button.text))).toEqual([["Беру · Забрать посылку", "Не могу"]]);
    const chat = { id: "700102", type: "private" as const };

    await press(markup.inline_keyboard[0]![0]!.callback_data, "700102", chat, markup.inline_keyboard);
    expect(await status(parcel.id)).toBe("accepted");
    expect(edits.at(-1)).toEqual([]);

    const filter = await familyTask("Заказать фильтры", "proposed", "700102");
    const second = (await requestKeyboard({ familyId: owner.familyId, now: new Date(), tasks: [filter], telegramUserId: "700102" }))!;
    await press(second.inline_keyboard[0]![1]!.callback_data, "700102", chat, second.inline_keyboard);
    expect(await status(filter.id)).toBe("declined");
  });

  it("lets the first member who presses «Беру» in the group take an unowned task", async () => {
    const trash = await familyTask("Вынести мусор", "open", null);
    const markup = (await unownedKeyboard({ chatId: GROUP_CHAT, familyId: owner.familyId, now: new Date(), tasks: [trash] }))!;
    const data = markup.inline_keyboard[0]![0]!.callback_data;
    const group = { id: GROUP_CHAT, type: "supergroup" as const };

    const overviewText = "Доброе утро! Общие дела семьи на сегодня.\n\n• Вынести мусор";
    await press(data, "700102", group, markup.inline_keyboard, undefined, overviewText);
    expect(await status(trash.id)).toBe("accepted");
    const assignee = await database().query<{ assignee_telegram_id: string }>("SELECT assignee_telegram_id FROM shared_tasks WHERE id=$1", [trash.id]);
    expect(assignee.rows[0]!.assignee_telegram_id).toBe("700102");
    // Everyone in the group sees who took it, and the button is gone from the same edit.
    expect(texts).toEqual([`${overviewText}\n\n✋ Member берёт: Вынести мусор`]);
    expect(edits.at(-1)).toEqual([]);

    // The same shared button, pressed by the other member a moment later, on the message as it was.
    await press(data, "700101", group, markup.inline_keyboard, undefined, overviewText);
    expect(answers.at(-1)).toEqual({ showAlert: true, text: "Это дело уже взяли." });
    expect(texts.at(-1)).toBe(`${overviewText}\n\n✋ Member берёт: Вынести мусор`);
    expect(assignee.rows[0]!.assignee_telegram_id).toBe("700102");
    expect(answeredBy).toEqual([member.userId, owner.userId]);
  });

  it("changes only the presser's own overview hour and switch", async () => {
    const [nine, off] = await taskButtonRepository.create({
      chatId: "700101", familyId: owner.familyId, now: new Date(), recipientTelegramId: "700101",
      items: [{ action: "digest_hour", value: 9 }, { action: "digest_off" }],
    });
    const chat = { id: "700101", type: "private" as const };
    await press(taskButtonCallbackData(nine!), "700101", chat);
    expect(await dailyOverviewSettings.read(owner.userId!)).toEqual({ enabled: true, hour: 9 });
    expect(answers.at(-1)!.text).toBe("Сводка будет приходить в 9:00.");
    await press(taskButtonCallbackData(off!), "700101", chat);
    expect(await dailyOverviewSettings.read(owner.userId!)).toEqual({ enabled: false, hour: 9 });
    expect(await dailyOverviewSettings.read(member.userId!)).toEqual({ enabled: true, hour: null });
  });

  it("refuses a button whose task changed since and removes it", async () => {
    const task = await makeTask(owner, "Сдать ключи");
    const data = await button({ chatId: "700101", item: { action: "complete", task: { id: task.id, version: task.version } }, recipient: "700101" });
    await tasks.execute(owner, { action: "update", id: task.id, version: task.version, title: "Сдать ключи в УК" } as never, "rename");

    await press(data, "700101", { id: "700101", type: "private" });
    expect(answers.at(-1)).toEqual({
      showAlert: true, text: "Это дело уже изменили. Скажи «покажи дела», чтобы увидеть, как оно сейчас.",
    });
    expect(edits.at(-1)).toEqual([[{ callback_data: "other", text: "Другое" }]]);
    expect((await taskButtonRepository.find(data.slice(3), new Date()))!.settled).toBe(true);
    expect(await status(task.id)).toBe("accepted");
  });
});
