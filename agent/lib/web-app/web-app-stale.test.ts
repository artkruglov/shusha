import { describe, expect, it } from "vitest";

import { staleTasksOf } from "./web-app-stale.js";

const task = (id: string, updatedOn: string, extra: Record<string, unknown> = {}) => ({
  dueAt: null, dueOn: null, id, kind: "task", listName: "Дом", source: "Личное", status: "accepted", title: `Дело ${id}`,
  updatedOn, version: 2, ...extra,
}) as never;

describe("tasks without movement in the Mini App", () => {
  it("lists accepted tasks unchanged for two weeks, oldest first, without the ones left alone", () => {
    const list = staleTasksOf([
      task("b", "2026-10-01"), task("a", "2026-09-15"), task("fresh", "2026-10-15"), task("kept", "2026-09-01"),
      task("idea", "2026-09-01", { kind: "idea" }), task("unowned", "2026-09-01", { status: "open" }),
    ], "2026-10-21", new Set(["kept"]));

    expect(list.map((item) => item.id)).toEqual(["a", "b"]);
    expect(list[0]).toEqual({ id: "a", project: "Дом", since: "2026-09-15", title: "Дело a", version: 2 });
  });
});
