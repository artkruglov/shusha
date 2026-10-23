/**
 * «↩ Вернуть» under a receipt.
 *
 * Constructs covered:
 * - Up to three reopenable tasks get one button each, for the person who closed them, under the
 *   delivered message; more than three, no message id or nothing to reopen get no buttons.
 * - In a private chat «Открыть доску» goes under them, also for a receipt with too many tasks to undo;
 *   a group chat or an unconfigured Mini App gets no board button.
 * - A failed edit is logged and never fails the delivered turn.
 * - In a private chat each new task gets «Сделать общим» or «Сделать личным», a task asked of another adult none,
 *   and a person not asked yet gets «Новые дела: для семьи · Только мне» once.
 * - One new personal record gets «В «группа»» for each live group; several records, a shared one and a group chat none.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../database-context.js", () => ({ withFamilyDatabaseContext: (_: string, work: () => unknown) => work() }));

import { attachReceiptUndo, type ReceiptUndoDependencies } from "./receipt-undo.js";

const IDS = ["0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a", "1f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a",
  "2f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a", "3f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a"];
const task = (n: number) => ({ id: `task-${n}`, title: `Дело ${n}`, version: n + 1 });

const BOARD = "https://bot.example/app/";

function fakes(edit: ReceiptUndoDependencies["editKeyboard"] = vi.fn(async () => undefined), board: string | null = null) {
  return {
    boardUrl: () => board, createButtons: vi.fn(async () => IDS), editKeyboard: vi.fn(edit),
    liveGroups: vi.fn(async (_familyId: string, _userId: string, _taskId: string): Promise<Array<{ id: string; title: string }>> => []),
  };
}

describe("receipt undo", () => {
  it("puts one button per reopenable task under the delivered message", async () => {
    const dependencies = fakes();
    await attachReceiptUndo({ chatId: "-100", familyId: "f", messageId: "42", telegramUserId: "7", undo: [task(1), task(2)] }, dependencies);
    expect(dependencies.createButtons).toHaveBeenCalledWith({
      chatId: "-100", familyId: "f", recipientTelegramId: "7",
      items: [{ action: "reopen", task: { id: "task-1", version: 2 } }, { action: "reopen", task: { id: "task-2", version: 3 } }],
    });
    expect(dependencies.editKeyboard).toHaveBeenCalledWith({
      chatId: "-100", messageId: "42",
      keyboard: [[{ callback_data: `tb:${IDS[0]}`, text: "↩ Вернуть · Дело 1" }], [{ callback_data: `tb:${IDS[1]}`, text: "↩ Вернуть · Дело 2" }]],
    });
  });

  it("opens the board from a private chat's receipt, even when there are too many tasks to undo", async () => {
    const dependencies = fakes(undefined, BOARD);
    await attachReceiptUndo({ chatId: "7", familyId: "f", messageId: "42", telegramUserId: "7", undo: [task(1)] }, dependencies);
    expect(dependencies.editKeyboard).toHaveBeenLastCalledWith({
      chatId: "7", messageId: "42",
      keyboard: [[{ callback_data: `tb:${IDS[0]}`, text: "↩ Вернуть" }], [{ text: "Открыть доску", web_app: { url: BOARD } }]],
    });
    await attachReceiptUndo({ chatId: "7", familyId: "f", messageId: "43", telegramUserId: "7", undo: [1, 2, 3, 4].map(task) }, dependencies);
    expect(dependencies.editKeyboard).toHaveBeenLastCalledWith({
      chatId: "7", messageId: "43", keyboard: [[{ text: "Открыть доску", web_app: { url: BOARD } }]],
    });
    expect(dependencies.createButtons).toHaveBeenCalledTimes(1);
    // A group: Telegram does not open a Mini App from an inline button there.
    await attachReceiptUndo({ chatId: "-100", familyId: "f", messageId: "44", telegramUserId: "7", undo: [task(1)] }, dependencies);
    expect(dependencies.editKeyboard.mock.lastCall![0].keyboard.flat().map((button) => button.text)).toEqual(["↩ Вернуть"]);
  });

  it("adds nothing for many tasks, no message or nothing to reopen", async () => {
    const dependencies = fakes();
    const base = { chatId: "1", familyId: "f", telegramUserId: "7" };
    await attachReceiptUndo({ ...base, messageId: "1", undo: [task(1), task(2), task(3), task(4)] }, dependencies);
    await attachReceiptUndo({ ...base, messageId: null, undo: [task(1)] }, dependencies);
    await attachReceiptUndo({ ...base, messageId: "1", undo: [] }, dependencies);
    expect(dependencies.createButtons).not.toHaveBeenCalled();
  });

  it("logs a failed edit instead of failing the turn", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dependencies = fakes(async () => { throw new Error("HTTP 400"); });
    await expect(attachReceiptUndo({ chatId: "1", familyId: "f", messageId: "1", telegramUserId: "7", undo: [task(1)] }, dependencies))
      .resolves.toBeUndefined();
    expect(error.mock.calls[0]![0]).toContain("AGENT_TASK_RECEIPT_UNDO_FAILED");
    error.mockRestore();
  });

  it("offers who sees each new task in a private chat, and asks the default once", async () => {
    const dependencies = fakes(undefined, BOARD);
    await attachReceiptUndo({
      askDefault: true, chatId: "7", familyId: "f", messageId: "42", telegramUserId: "7", undo: [],
      created: [
        { askedOther: false, id: "task-1", scope: "personal", title: "Купить шины", version: 1 },
        { askedOther: true, id: "task-2", scope: "family", title: "Забрать посылку", version: 1 },
      ],
    }, dependencies);
    expect(dependencies.createButtons).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ action: "share", task: { id: "task-1", version: 1 } }, { action: "default_family" }, { action: "default_personal" }],
    }));
    expect(dependencies.editKeyboard).toHaveBeenCalledWith({
      chatId: "7", messageId: "42",
      keyboard: [
        [{ callback_data: `tb:${IDS[0]}`, text: "Сделать общим" }],
        [{ callback_data: `tb:${IDS[1]}`, text: "Новые дела: для семьи" }],
        [{ callback_data: `tb:${IDS[2]}`, text: "Новые дела: только мне" }],
        [{ text: "Открыть доску", web_app: { url: BOARD } }],
      ],
    });
  });

  it("gives a group receipt of new tasks no who-sees buttons", async () => {
    const dependencies = fakes();
    await attachReceiptUndo({
      askDefault: true, chatId: "-100", familyId: "f", messageId: "42", telegramUserId: "7", undo: [],
      created: [{ askedOther: false, id: "task-1", scope: "family", title: "Вынести мусор", version: 1 }],
    }, dependencies);
    expect(dependencies.editKeyboard).not.toHaveBeenCalled();
  });

  it("offers the person's live groups under one new personal record only, in a second edit", async () => {
    const dependencies = fakes();
    dependencies.liveGroups.mockResolvedValue([{ id: "g1", title: "Квартира" }]);
    dependencies.createButtons.mockResolvedValueOnce([IDS[0]!]).mockResolvedValueOnce([IDS[1]!]);
    const created = (scope: "family" | "personal", n: number) => ({ ...task(n), askedOther: false, scope });
    await attachReceiptUndo({ chatId: "7", created: [created("personal", 1)], familyId: "f", messageId: "42", telegramUserId: "7", undo: [] }, dependencies);
    expect(dependencies.liveGroups).toHaveBeenCalledWith("f", "7", "task-1");
    expect(dependencies.createButtons).toHaveBeenNthCalledWith(1, expect.objectContaining({ items: [{ action: "share", task: { id: "task-1", version: 2 } }] }));
    expect(dependencies.createButtons).toHaveBeenNthCalledWith(2, expect.objectContaining({
      items: [{ action: "to_group", groupId: "g1", task: { id: "task-1", version: 2 } }] }));
    // The first edit does not wait for the groups; the second adds them.
    expect(dependencies.editKeyboard.mock.calls[0]![0].keyboard.flat().map((button) => button.text)).toEqual(["Сделать общим"]);
    expect(dependencies.editKeyboard.mock.lastCall![0].keyboard).toEqual([
      [{ callback_data: `tb:${IDS[0]}`, text: "Сделать общим" }], [{ callback_data: `tb:${IDS[1]}`, text: "В «Квартира»" }]]);
    for (const input of [
      { chatId: "7", created: [created("personal", 1), created("personal", 2)] },
      { chatId: "7", created: [created("family", 1)] },
      { chatId: "-100", created: [created("personal", 1)] },
    ]) {
      dependencies.liveGroups.mockClear();
      await attachReceiptUndo({ ...input, familyId: "f", messageId: "43", telegramUserId: "7", undo: [] }, dependencies);
      expect(dependencies.liveGroups).not.toHaveBeenCalled();
    }
  });

  it("keeps the first keyboard when the groups cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dependencies = fakes();
    dependencies.liveGroups.mockRejectedValue(new Error("db"));
    await attachReceiptUndo({ chatId: "7", created: [{ ...task(1), askedOther: false, scope: "personal" }], familyId: "f",
      messageId: "42", telegramUserId: "7", undo: [] }, dependencies);
    expect(dependencies.editKeyboard).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toContain("AGENT_TASK_RECEIPT_GROUPS_FAILED");
    error.mockRestore();
  });
});
