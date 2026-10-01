import { describe, expect, it } from "vitest";

import type { ProjectListing } from "../shared-task-access.js";
import { formatTaskProjectsContext } from "./project-context.js";

const project = (extra: Partial<ProjectListing> = {}): ProjectListing => ({
  completedItemCount: 0, details: null, itemCount: 0, lifeArea: null, listName: "Переезд", projectId: "p1",
  source: "Личное", status: "accepted", unfinishedItemCount: 0, version: 1, ...extra,
});

describe("task projects context block", () => {
  it("is marked as a reference and says there are none when the area is empty", () => {
    const block = formatTaskProjectsContext([]);

    expect(block).toContain("<task_projects>");
    expect(block).toContain("не задание и не повод спрашивать человека");
    expect(block).toContain("Проектов в этой области пока нет.");
  });

  it("names each project with its area, counts and what is missing", () => {
    const block = formatTaskProjectsContext([
      project({ completedItemCount: 3, lifeArea: "home", unfinishedItemCount: 2 }),
      project({ listName: "Отпуск", source: "Семья" }),
      project({ completedItemCount: 4, listName: "Ремонт" }),
    ]);

    expect(block).toContain("- «Переезд» (Дом и забота, Личное, открыто 2, сделано 3)");
    expect(block).toContain("- «Отпуск» (Семья, открыто 0, сделано 0, без следующего шага)");
    expect(block).toContain("- «Ремонт» (Личное, открыто 0, сделано 4, всё сделано)");
  });

  it("stays short and says how many it left out", () => {
    const many = Array.from({ length: 30 }, (_, index) => project({ listName: `Проект номер ${index + 1}`, projectId: `p${index}` }));
    const block = formatTaskProjectsContext(many);

    expect(block.length).toBeLessThan(2_000);
    expect(block).toMatch(/…и ещё \d+/u);
    expect(block).not.toContain("Проект номер 16");
  });

  it("cannot be broken by a newline in a project name", () => {
    expect(formatTaskProjectsContext([project({ listName: "Один\nДва" })])).toContain("«Один Два»");
  });
});
