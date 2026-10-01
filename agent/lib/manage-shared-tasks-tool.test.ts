/** manage_shared_tasks gives the model a ready board with every list, so it never retells tasks. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  timezone: vi.fn(async () => "Europe/Moscow"),
}));
vi.mock("./shared-task-repository.js", () => ({ sharedTaskRepository: { execute: mocks.execute } }));
vi.mock("./current-time-repository.js", () => ({ currentTimeRepository: { findTurnTimezone: mocks.timezone } }));
vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization: () => ({ familyId: "family-1", userId: "user-1" }),
}));

import manageSharedTasks from "./tools/manage_shared_tasks.js";
import { takeTelegramKeepOpenMark } from "./telegram-keep-open-turns.js";
import { progressNoticeKey } from "./telegram-progress-deferral.js";

const row = (title: string, listName: string) => ({
  dueAt: null, dueOn: null, id: title, kind: "task", listName, source: "Личное", status: "accepted", title, version: 1,
});
const context = { callId: "call-1", session: { id: "session-1" } } as never;

describe("manage_shared_tasks list board", () => {
  beforeEach(() => mocks.execute.mockReset());

  it("returns a board of every list next to the rows", async () => {
    mocks.execute.mockResolvedValue({ incomplete: false, nextCursor: null, tasks: [row("Написать подрядчику", "Работа"), row("Отвезти машину", "Дом")] });

    const result = await manageSharedTasks.execute({ action: "list" } as never, context) as { board: string; tasks: unknown[] };

    expect(result.tasks).toHaveLength(2);
    expect(result.board).toContain("<telegram-keep-open>");
    // Ответ модели рисуется как Rich Markdown: пункт обязан быть пунктом списка, иначе секция
    // склеится в один абзац.
    expect(result.board).toContain("**Дом · 1**\n\n- Отвезти машину");
    expect(result.board).toContain("**Работа · 1**\n\n- Написать подрядчику");
  });

  it("adds no board to someone else's commitments", async () => {
    mocks.execute.mockResolvedValue({ incomplete: false, nextCursor: null, tasks: [row("Забрать посылку", "Дом")] });

    expect(await manageSharedTasks.execute({ action: "list", view: "waiting" } as never, context))
      .not.toHaveProperty("board");
  });

  it("adds no board to a change", async () => {
    mocks.execute.mockResolvedValue({ replayed: false, task: row("Дело", "Дом") });

    expect(await manageSharedTasks.execute({ action: "create", title: "Дело" } as never, context)).not.toHaveProperty("board");
  });
});

describe("manage_shared_tasks says where a record went", () => {
  beforeEach(() => mocks.execute.mockReset());
  const filedRow = (title: string, extra: Record<string, unknown> = {}) => ({
    assignee: "Анна", dueAt: null, dueOn: null, id: title, kind: "task", lifeArea: null, listName: null, scope: "personal",
    source: "Личное", status: "accepted", title, version: 1, ...extra,
  });

  it("returns a ready line with the place, so the model does not have to guess or stay silent", async () => {
    mocks.execute.mockResolvedValue({ replayed: false, task: filedRow("Отвезти машину", { listName: "Дом" }) });

    const result = await manageSharedTasks.execute({ action: "create", title: "Отвезти машину" } as never, context) as
      { filed: string };

    expect(result.filed).toBe("• «Отвезти машину» → список «Дом», без срока, видишь только ты");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("gives no counter and no list suggestions, because the model read them as an order to ask", async () => {
    mocks.execute.mockResolvedValue({ replayed: false, task: filedRow("Купить батарейки") });

    const result = await manageSharedTasks.execute({ action: "create", title: "Купить батарейки" } as never, context) as
      { filed: string };

    expect(result.filed).toContain("пока без списка");
    expect(result).not.toHaveProperty("unsorted");
    expect(result).not.toHaveProperty("listChoices");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("describes a batch of creations in order and leaves closures out of it", async () => {
    mocks.execute.mockResolvedValueOnce({ replayed: false, tasks: [
      filedRow("Купить лампочки", { listName: "Дом" }), filedRow("Уже закрытое", { status: "completed" }), filedRow("Позвонить бабушке"),
    ] }).mockResolvedValueOnce({ lists: [{ itemCount: 4, listName: "Дом", source: "Личное", unfinishedItemCount: 4 }] });

    const result = await manageSharedTasks.execute({ action: "batch", items: [
      { action: "create", title: "Купить лампочки" }, { action: "complete", id: "x", version: 1 }, { action: "create", title: "Позвонить бабушке" },
    ] } as never, context) as { filed: string };

    expect(result.filed.split("\n")).toHaveLength(2);
    expect(result.filed).toContain("«Купить лампочки»");
    expect(result.filed).toContain("«Позвонить бабушке»");
    expect(result.filed).not.toContain("Уже закрытое");
  });

  it("says nothing about a replayed call and nothing about a read", async () => {
    mocks.execute.mockResolvedValue({ replayed: true, task: filedRow("Дело") });
    expect(await manageSharedTasks.execute({ action: "create", title: "Дело" } as never, context)).not.toHaveProperty("filed");

    mocks.execute.mockResolvedValue({ task: filedRow("Дело") });
    expect(await manageSharedTasks.execute({ action: "get", id: "x" } as never, context)).not.toHaveProperty("filed");
  });

  it("reports where a clarified record went, which is the answer to the question it asked", async () => {
    mocks.execute.mockResolvedValue({ replayed: false, task: filedRow("Узнать места в кружке", { listName: "Дети · Кружки", dueOn: "2026-10-03" }) });

    const result = await manageSharedTasks.execute({ action: "clarify", id: "x", version: 1, listName: "Дети · Кружки" } as never, context) as { filed: string };

    expect(result.filed).toBe("• «Узнать места в кружке» → список «Дети · Кружки», срок 03.10, видишь только ты");
  });
});

describe("manage_shared_tasks tells who now owns a closed unowned task", () => {
  beforeEach(() => mocks.execute.mockReset());
  const closed = (title: string) => ({ assignee: "Анна", dueAt: null, dueOn: null, id: title, kind: "task", lifeArea: null,
    listName: null, scope: "family", source: "Семья", status: "completed", title, version: 2 });

  it("adds a notice to a single closure and keeps the internal titles out of the reply", async () => {
    mocks.execute.mockResolvedValue({ adopted: [{ title: "Встретить мебельщиков", assignee: "Анна" }], replayed: false, task: closed("Встретить мебельщиков") });

    const result = await manageSharedTasks.execute({ action: "complete", id: "x", version: 1 } as never, context) as
      { notice: string };

    expect(result.notice).toBe("Было ничьё, никто не брал: «Встретить мебельщиков». Закрыто, исполнитель: Анна.");
    expect(result).not.toHaveProperty("adopted");
  });

  it("adds the notice next to the filed lines of a mixed batch", async () => {
    mocks.execute.mockResolvedValue({ adopted: [{ title: "Выкинуть мусор", assignee: "Анна" }], replayed: false, tasks: [
      { ...closed("Выкинуть мусор") }, { ...closed("Купить щётку"), status: "proposed" },
    ] });

    const result = await manageSharedTasks.execute({ action: "batch", items: [
      { action: "complete", id: "x", version: 1 }, { action: "create", title: "Купить щётку" },
    ] } as never, context) as { filed: string; notice: string };

    expect(result.notice).toContain("«Выкинуть мусор»");
    expect(result.filed).toContain("«Купить щётку»");
  });

  it("says nothing when no unowned task was closed", async () => {
    mocks.execute.mockResolvedValue({ replayed: false, task: closed("Дело") });

    expect(await manageSharedTasks.execute({ action: "complete", id: "x", version: 1 } as never, context))
      .not.toHaveProperty("notice");
  });
});

describe("manage_shared_tasks marks the turn so the channel keeps its summary open", () => {
  beforeEach(() => mocks.execute.mockReset());
  const withTurn = (turnId: string) => ({ callId: "call-1", session: { id: "session-9", turn: { id: turnId } } }) as never;
  const row = (status: string) => ({ assignee: "Анна", dueAt: null, dueOn: null, id: "x", kind: "task", lifeArea: null,
    listName: null, scope: "family", source: "Семья", status, title: "Дело", version: 1 });

  it("marks a turn that created a task and one that closed an unowned task, but not a plain read", async () => {
    mocks.execute.mockResolvedValue({ replayed: false, task: row("accepted") });
    await manageSharedTasks.execute({ action: "create", title: "Дело" } as never, withTurn("t-create"));
    mocks.execute.mockResolvedValue({ adopted: [{ title: "Дело", assignee: "Анна" }], replayed: false, task: row("completed") });
    await manageSharedTasks.execute({ action: "complete", id: "x", version: 1 } as never, withTurn("t-close"));
    mocks.execute.mockResolvedValue({ task: row("accepted") });
    await manageSharedTasks.execute({ action: "get", id: "x" } as never, withTurn("t-read"));

    expect(takeTelegramKeepOpenMark(progressNoticeKey("session-9", "t-create"))).toBe(true);
    expect(takeTelegramKeepOpenMark(progressNoticeKey("session-9", "t-close"))).toBe(true);
    expect(takeTelegramKeepOpenMark(progressNoticeKey("session-9", "t-read"))).toBe(false);
  });
});
