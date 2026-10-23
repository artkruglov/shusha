import { describe, expect, it, vi } from "vitest";

import { formatMyTasks, pressFamilyBoard, pressMyTasks } from "./my-tasks-press.js";

const task = (title: string, extra: Record<string, unknown> = {}) =>
  ({ dueAt: null, dueOn: null, kind: "task", listName: null, source: "Семья", status: "accepted", title, ...extra }) as never;

describe("«Мои дела» in the family group", () => {
  it("lists open family tasks one a line, counts honestly, and points to the private chat for the rest", () => {
    const many = Array.from({ length: 12 }, (_, index) => task(`Дело ${index + 1}`));
    expect(formatMyTasks([...many, task("Готово", { status: "completed" }), task("Идея", { kind: "idea" })]))
      .toBe(["Твои семейные дела · 12 · показано 10", ...Array.from({ length: 10 }, (_, index) => `• Дело ${index + 1}`), "",
        "Личные дела — в личке со мной."].join("\n"));
    expect(formatMyTasks([])).toBe("Семейных дел на тебе нет.\n\nЛичные дела — в личке со мной.");
  });

  it("sends nothing to the group when the ephemeral message is refused, and tells the presser where to look", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const said = await pressMyTasks({
      board: async () => null,
      list: async () => [task("Вынести мусор")],
      sendEphemeral: vi.fn().mockRejectedValue(new Error("Bad Request")),
      sendEphemeralRich: vi.fn(),
    }, { auth: {} as never, callbackQueryId: "q", chatId: "-103", presserId: "700101" });

    expect(said).toEqual({ alert: true, text: "Здесь показать не получилось. Напиши мне в личку «покажи дела»." });
  });

  it("sends the family board to the presser only and says so when there is nothing to show", async () => {
    const sendEphemeralRich = vi.fn().mockResolvedValue(undefined);
    const input = { auth: {} as never, callbackQueryId: "q", chatId: "-103", presserId: "700101" };
    const deps = { board: async () => "### Твои дела", list: async () => [], sendEphemeral: vi.fn(), sendEphemeralRich };

    expect(await pressFamilyBoard(deps, input)).toEqual({ alert: false, text: "" });
    expect(sendEphemeralRich).toHaveBeenCalledWith({ callbackQueryId: "q", chatId: "-103", markdown: "### Твои дела", receiverId: "700101" });
    expect(await pressFamilyBoard({ ...deps, board: async () => null }, input)).toEqual({ alert: true, text: "Открытых семейных дел нет." });
  });
});
