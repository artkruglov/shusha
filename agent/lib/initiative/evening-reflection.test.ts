/**
 * Итог дня: закрытое сегодня до трёх названий, открытое на сегодня до двух без упрёка, шаг проекта, вопрос о главном
 * на завтра; пустой день молчит; первое сообщение говорит, как выключить.
 */
import { describe, expect, it } from "vitest";

import type { OverviewTask } from "./daily-overview.js";
import {
  EVENING_REFLECTION_FIRST_LINE, EVENING_REFLECTION_QUESTION, eveningReflectionInput, formatEveningReflection,
} from "./evening-reflection.js";

// Среда 21 октября 2026, 20:30 по Москве.
const now = new Date("2026-10-21T17:30:00Z");
const task = (title: string, extra: Partial<OverviewTask> = {}): OverviewTask => ({
  dueAt: null, dueOn: null, kind: "task", listName: null, source: "Личное", status: "accepted", title, ...extra,
});
const project = (id: string, title: string, open: number) =>
  ({ completed: 0, hasNextStep: open > 0, id, open, source: "Личное", status: "accepted", title, total: open });

describe("evening reflection", () => {
  it("sums up the day: closed, still open today, a project step and the question", () => {
    const input = eveningReflectionInput({
      now, timezone: "Europe/Moscow", waiting: [],
      projects: [project("move", "Переезд", 1)],
      tasks: [
        task("Позвонить врачу", { dueOn: "2026-10-21" }),
        task("Оплатить кружок", { dueOn: "2026-10-21" }),
        task("Купить шторы", { dueOn: "2026-10-21" }),
        task("Заказать матрас", { dueOn: "2026-10-25", projectId: "move" }),
        task("Забрать посылку", { dueOn: "2026-10-21", status: "proposed" }),
        task("Идея: поход", { kind: "idea" }),
      ],
    }, ["Отправить отчёт", "Вынести мусор", "Купить хлеб", "Полить цветы"], false);

    expect(formatEveningReflection(input)).toBe([
      "Добрый вечер. Короткий итог дня.", "",
      "Сделано сегодня · 4 · показано 3", "• Отправить отчёт", "• Вынести мусор", "• Купить хлеб", "",
      "Ещё на сегодня · 3 · показано 2", "• Позвонить врачу", "• Оплатить кружок",
      "Не успеется — скажи, перенесу на завтра.", "",
      "Шаг по проекту «Переезд»: Заказать матрас.", "",
      EVENING_REFLECTION_QUESTION,
    ].join("\n"));
  });

  it("asks about tomorrow after a day with only closed tasks, and explains itself the first time", () => {
    const text = formatEveningReflection({ closed: ["Купить хлеб"], first: true, openToday: [], projectLine: null })!;
    expect(text).toBe([
      "Добрый вечер. Короткий итог дня.", "", "Сделано сегодня · 1", "• Купить хлеб", "",
      EVENING_REFLECTION_QUESTION, "", EVENING_REFLECTION_FIRST_LINE,
    ].join("\n"));
    expect(EVENING_REFLECTION_FIRST_LINE).toContain("Не писать вечером");
  });

  it("stays silent after an empty day and never reproaches", () => {
    expect(formatEveningReflection({ closed: [], first: false, openToday: [], projectLine: null })).toBeNull();
    const open = formatEveningReflection({ closed: [], first: false, openToday: ["Позвонить"], projectLine: null })!;
    expect(open).not.toMatch(/не сделал|не успел[аи]?\b|провал|опять/u);
  });

  it("does not write a day's summary for a project step alone: a step due in a month is not the day", () => {
    // Ревью 23 октября 2026: один шаг проекта со сроком через месяц присылал «итог дня» каждый вечер.
    const input = eveningReflectionInput({
      now, timezone: "Europe/Moscow", waiting: [], projects: [project("move", "Переезд", 1)],
      tasks: [task("Заказать матрас", { dueOn: "2026-11-20", projectId: "move" })],
    }, [], false);
    expect(input.projectLine).not.toBeNull();
    expect(formatEveningReflection(input)).toBeNull();
  });
});
