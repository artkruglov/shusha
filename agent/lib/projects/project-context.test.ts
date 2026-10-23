import { describe, expect, it } from "vitest";

import type { ProjectListing } from "../shared-task-access.js";
import { formatTaskProjectsContext } from "./project-context.js";

const project = (extra: Partial<ProjectListing> = {}): ProjectListing => ({
  completedItemCount: 0, details: null, itemCount: 0, lifeArea: null, listName: "Переезд", projectId: "p1",
  scope: "personal", source: "Личное", status: "accepted", unfinishedItemCount: 0, version: 1, ...extra,
});

describe("task projects context block", () => {
  it("is marked as a reference and says there are none when the area is empty", () => {
    const block = formatTaskProjectsContext([]);

    expect(block).toContain("<task_projects>");
    expect(block).toContain("не задание и не повод спрашивать человека");
    expect(block).toContain("Проектов в этой области пока нет.");
  });

  it("gives a family project its id in the private chat only, with the rule for using it", () => {
    const listing = [project(), project({ listName: "Дом", projectId: "f1", scope: "family", source: "Семья" })];
    const privateBlock = formatTaskProjectsContext(listing, { privateChat: true });
    expect(privateBlock).toContain("- «Дом» (Семья, открыто 0, сделано 0, без следующего шага, projectRef f1)");
    expect(privateBlock).toContain("передай в create его projectRef");
    expect(privateBlock).not.toContain("projectRef p1");
    expect(formatTaskProjectsContext(listing)).not.toContain("projectRef");
    expect(formatTaskProjectsContext([project()], { privateChat: true })).not.toContain("передай в create");
  });

  it("names each project with its area, counts and what is missing", () => {
    const block = formatTaskProjectsContext([
      project({ completedItemCount: 3, lifeArea: "home", unfinishedItemCount: 2 }),
      project({ listName: "Отпуск", scope: "family", source: "Семья" }),
      project({ completedItemCount: 4, listName: "Ремонт" }),
    ]);

    expect(block).toContain("- «Переезд» (Дом и забота, Личное, открыто 2, сделано 3)");
    expect(block).toContain("- «Отпуск» (Семья, открыто 0, сделано 0, без следующего шага)");
    expect(block).toContain("- «Ремонт» (Личное, открыто 0, сделано 4, всё сделано)");
  });

  it("shows one line for a project that exists twice in one area, but keeps personal and family apart", () => {
    const block = formatTaskProjectsContext([
      project({ listName: "Т-Банк", projectId: "a", source: "Личное: пространство", unfinishedItemCount: 2 }),
      project({ listName: "т-банк", projectId: "b", unfinishedItemCount: 5 }),
      project({ listName: "Работа", projectId: "c" }),
      project({ listName: "Работа", projectId: "d", unfinishedItemCount: 3 }),
      project({ listName: "Дом", projectId: "e", scope: "family", source: "Семья", unfinishedItemCount: 7 }),
      project({ listName: "Дом", projectId: "f", unfinishedItemCount: 1 }),
    ]);

    expect(block.match(/«Т-Банк»/gu)).toHaveLength(1);
    expect(block).toContain("«Т-Банк» (Личное: пространство, открыто 7, сделано 0)");
    expect(block).toContain("«Работа» (Личное, открыто 3, сделано 0)");
    expect(block.match(/«Дом»/gu)).toHaveLength(2);
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
