import { describe, expect, it } from "vitest";

import type { OverviewTask } from "../initiative/daily-overview.js";
import { webAppBoard } from "./web-app-board.js";

const NOW = new Date("2026-10-18T09:00:00Z");

function task(title: string, fields: Partial<OverviewTask> = {}): OverviewTask {
  return {
    dueAt: null, dueOn: "2026-10-18", id: `id-${title}`, kind: "task", listName: null, source: "Личное",
    status: "accepted", title, version: 3, ...fields,
  };
}

describe("webAppBoard", () => {
  it("gives each row only the actions that can work on it", () => {
    const board = webAppBoard({
      now: NOW,
      tasks: [
        task("Своё"),
        task("Ничьё", { dueOn: null, status: "open" }),
        task("Поручено мне", { dueOn: null, status: "proposed", assignee: "Юля" }),
        task("Ко времени", { dueAt: "2026-10-18T15:00:00Z", dueOn: null }),
        task("Каждую неделю", { repeat: { interval: 1, unit: "week" } }),
        task("Идея", { dueOn: null, kind: "idea" }),
        task("Традиция", { dueOn: null, kind: "ritual", repeat: { unit: "weekly" } }),
      ],
      timezone: "UTC",
      waiting: [task("Попросил Юлю", { assignee: "Юля", dueOn: null, status: "proposed" })],
    }, "2026-10-18");
    const rows = Object.fromEntries(board.sections.flatMap((section) => section.rows).map((row) => [row.title, row]));
    expect(rows["Своё"]).toMatchObject({ actions: ["complete", "postpone"], id: "id-Своё", version: 3 });
    expect(rows["Ничьё"]).toMatchObject({ actions: ["claim", "complete"], id: "id-Ничьё" });
    expect(rows["Поручено мне"]).toMatchObject({ actions: ["accept", "decline"], id: "id-Поручено мне" });
    // An exact time or a repeat is moved in words: a tap would drop the time or shift the series.
    expect(rows["Ко времени"]!.actions).toEqual(["complete"]);
    expect(rows["Каждую неделю"]!.actions).toEqual(["complete"]);
    // No buttons, yet the id opens the card.
    for (const title of ["Идея", "Традиция", "Попросил Юлю"]) {
      expect(rows[title]).toMatchObject({ actions: [], id: `id-${title}` });
    }
    expect(rows["Традиция"]!.repeat).toBe(true);
    expect(board.today).toBe("2026-10-18");
  });

  it("offers no «Перенести» to a child, who may close their own task but not edit it", () => {
    const board = webAppBoard({ now: NOW, tasks: [task("Своё")], timezone: "UTC" }, "2026-10-18", { canMove: false });
    expect(board.sections[0]!.rows[0]!.actions).toEqual(["complete"]);
  });

  it("names a project's section by the project alone: the page opens it, the chat's area tag is not needed", () => {
    const board = webAppBoard({
      now: NOW,
      projects: [{ completed: 1, hasNextStep: true, id: "p1", open: 1, source: "Семья", status: "accepted", title: "Ремонт", total: 2 }],
      tasks: [task("Выбрать плитку", { dueOn: null, listName: "Ремонт", projectId: "p1", source: "Семья" })],
      timezone: "UTC",
    } as never, "2026-10-18");
    expect(board.sections.find((section) => section.kind === "project")).toMatchObject({ project: { id: "p1" }, title: "Ремонт" });
  });
});
