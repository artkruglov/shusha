/** «✓ ~~дело~~» in the morning overview: struck in place, undone by «Вернуть», bold headers untouched. */
import { describe, expect, it } from "vitest";

import { formatShortDailyOverview } from "../initiative/daily-overview-short.js";
import { struckOverview } from "./overview-strike.js";

const base = {
  now: new Date("2026-10-17T06:00:00Z"),
  projects: undefined,
  timezone: "Europe/Moscow",
  waiting: [],
} as const;
const task = (title: string, dueOn: string, repeat?: unknown) => ({
  assignee: null, dueAt: null, dueOn, kind: "task", listName: null, source: "chat", status: "accepted", title,
  ...(repeat ? { repeat } : {}),
});
const slice = (text: string, entity: { length: number; offset: number }) => text.slice(entity.offset, entity.offset + entity.length);

describe("struck overview", () => {
  const overview = formatShortDailyOverview({
    ...base,
    tasks: [task("Заказать матрас", "2026-10-14"), task("Подготовить видео", "2026-10-17"), task("Полить цветы", "2026-10-17", { unit: "week" })],
  } as never)!;

  it("turns the closed line into «✓ дело» struck through, keeping the bold headers in place", () => {
    const result = struckOverview(overview.text, overview.entities, [{ closed: true, title: "Заказать матрас" }, { closed: false, title: "Подготовить видео" }])!;
    expect(result.text.split("\n")).toContain("✓ Заказать матрас — срок 14.10");
    expect(result.text.split("\n")).toContain("• Подготовить видео");
    const struck = result.entities.filter((entity) => entity.type === "strikethrough");
    expect(struck.map((entity) => slice(result.text, entity))).toEqual(["Заказать матрас"]);
    expect(result.entities.filter((entity) => entity.type === "bold").map((entity) => slice(result.text, entity)))
      .toEqual(overview.entities.map((entity) => slice(overview.text, entity)));
  });

  it("finds a repeated task's line behind its 🔁 and undoes the strike after «Вернуть»", () => {
    const closed = struckOverview(overview.text, overview.entities, [{ closed: true, title: "Подготовить видео" }])!;
    expect(closed.entities.filter((entity) => entity.type === "strikethrough").map((entity) => slice(closed.text, entity)))
      .toEqual(["Подготовить видео"]);
    const reopened = struckOverview(closed.text, closed.entities, [{ closed: false, title: "Подготовить видео" }])!;
    expect(reopened.text).toBe(overview.text);
    expect(reopened.entities).toEqual(overview.entities);
    expect(overview.text).toContain("• 🔁 Полить цветы");
  });

  it("says there is nothing to edit when the text already shows it, or no line is about these tasks", () => {
    const closed = struckOverview(overview.text, overview.entities, [{ closed: true, title: "Заказать матрас" }])!;
    expect(struckOverview(closed.text, closed.entities, [{ closed: true, title: "Заказать матрас" }])).toBeNull();
    expect(struckOverview(overview.text, overview.entities, [{ closed: true, title: "Чужое дело" }])).toBeNull();
    // A receipt is not an overview: its lines do not start with a bullet.
    expect(struckOverview("✓ Закрыто: Заказать матрас", [], [{ closed: false, title: "Заказать матрас" }])).toBeNull();
  });

  it("tells two tasks with the same title apart by the order of their buttons", () => {
    const twins = formatShortDailyOverview({
      ...base, tasks: [task("Купить хлеб", "2026-10-17"), task("Купить хлеб", "2026-10-17")],
    } as never)!;
    const second = struckOverview(twins.text, twins.entities, [{ closed: false, title: "Купить хлеб" }, { closed: true, title: "Купить хлеб" }])!;
    expect(second.text.split("\n").slice(-2)).toEqual(["• Купить хлеб", "✓ Купить хлеб"]);
    expect(second.entities.filter((entity) => entity.type === "strikethrough")).toHaveLength(1);
  });
});
