import { describe, expect, it } from "vitest";

import { collapseBoardProjects } from "./project-board.js";

const project = (extra: Record<string, unknown> = {}) => ({
  completed: 0, hasNextStep: false, id: "p1", open: 0, scope: "personal", source: "Личное", status: "accepted" as const,
  title: "Работа", total: 0, ...extra,
});

describe("board projects", () => {
  it("counts a project that exists twice in one area as one, so the empty twin is not 'without a step'", () => {
    const merged = collapseBoardProjects([
      project({ id: "a", source: "Личное: пространство" }),
      project({ completed: 1, hasNextStep: true, id: "b", open: 2, total: 3 }),
    ]);

    expect(merged).toEqual([expect.objectContaining({ aliases: ["b"], completed: 1, hasNextStep: true, id: "a", open: 2, total: 3 })]);
    expect(merged[0]).not.toHaveProperty("scope");
  });

  it("keeps personal and family projects with one name apart, and closed apart from live", () => {
    const merged = collapseBoardProjects([
      project({ id: "a", title: "Дом" }),
      project({ id: "b", scope: "family", title: "Дом" }),
      project({ id: "c", status: "completed", title: "Дом" }),
    ]);

    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps one-named projects of two different groups apart", () => {
    const merged = collapseBoardProjects([
      project({ id: "a", scope: "group", source: "Соседи", title: "Праздник" }),
      project({ id: "b", scope: "group", source: "Работа", title: "Праздник" }),
    ]);

    expect(merged.map((item) => item.id)).toEqual(["a", "b"]);
  });
});
