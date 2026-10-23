/**
 * Короткий утренний обзор.
 *
 * Проверяется: только принятые дела человека, сначала сегодня, просроченного до двух; не больше пяти строк и «показано N»;
 * ничьё и свои просьбы одной строкой со счётчиком, просьбы к человеку названиями, неделя без ответа на свою просьбу; день без сроков говорит это прямо; день без
 * обязательств молчит; первое сообщение объясняет себя.
 */
import { describe, expect, it } from "vitest";

import type { OverviewTask } from "./daily-overview.js";
import { formatShortDailyOverview } from "./daily-overview-short.js";

const now = new Date("2026-10-17T06:00:00Z");
const task = (title: string, extra: Partial<OverviewTask> = {}): OverviewTask => ({
  dueAt: null, dueOn: null, kind: "task", listName: null, source: "Личное", status: "accepted", title, ...extra,
});
const overview = (tasks: OverviewTask[]) => ({ now, tasks, timezone: "Europe/Moscow", waiting: [] });

describe("formatShortDailyOverview", () => {
  it("opens with today, shows at most two overdue, at most five in all, and counts the rest on two short lines", () => {
    const result = formatShortDailyOverview(overview([
      task("Заказать матрас", { dueOn: "2026-10-14", id: "t1", version: 2 }),
      task("Сдать ключи", { dueOn: "2026-10-15" }),
      task("Позвонить мастеру", { dueOn: "2026-10-16" }),
      ...["Видео", "Страховка"].map((title) => task(title, { dueOn: "2026-10-17" })),
      task("Когда-нибудь починить полку"),
      task("Вынести мусор", { status: "open", dueOn: "2026-10-17" }),
      task("Забрать посылку", { status: "proposed" }),
      task("Идея про отпуск", { kind: "idea" }),
    ]))!;
    expect(result.text).toBe([
      "Доброе утро.", "",
      "Сегодня · 2", "• Видео", "• Страховка", "",
      "⚠️ Просрочено · 3 · показано 2", "• Заказать матрас — срок 14.10", "• Сдать ключи — срок 15.10", "",
      "Просят тебя · 1", "• Забрать посылку", "Ответь «беру» или «не могу»: кнопками в напоминании или словами здесь.", "",
      "Ещё дел · 1", "Никто не взял · 1",
    ].join("\n"));
    expect(result.shown.map((shown) => shown.title)).toEqual(["Видео", "Страховка", "Заказать матрас", "Сдать ключи"]);
    expect(result.openCount).toBe(8);
    // The greeting and section headers are bold by offset; the text itself stays plain.
    const bold = result.entities.map((entity) => result.text.slice(entity.offset, entity.offset + entity.length));
    expect(bold).toEqual(["Доброе утро.", "Сегодня · 2", "⚠️ Просрочено · 3 · показано 2", "Просят тебя · 1"]);
    expect(result.entities.every((entity) => entity.type === "bold")).toBe(true);
  });

  it("gives today all five lines when there are five, and overdue then waits", () => {
    const result = formatShortDailyOverview(overview([
      task("Заказать матрас", { dueOn: "2026-10-14" }),
      ...["А", "Б", "В", "Г", "Д", "Е"].map((title) => task(title, { dueOn: "2026-10-17" })),
    ]))!;
    expect(result.shown.map((shown) => shown.title)).toEqual(["А", "Б", "В", "Г", "Д"]);
    expect(result.text).toBe("Доброе утро.\n\nСегодня · 6 · показано 5\n• А\n• Б\n• В\n• Г\n• Д\n\n⚠️ Просрочено · 1");
  });

  it("stops repeating an overdue task once its message went or the person left it alone, but not on its own day", () => {
    // 21 октября 2026: одни и те же просрочки стояли в обзоре по 26–31 утру; ревью того же дня: «Оставить»
    // не прячет дело в день его срока.
    const result = formatShortDailyOverview({
      ...overview([
        task("Договориться о встрече", { dueOn: "2026-09-15", id: "old", version: 3 }),
        task("Оставленное просроченное", { dueOn: "2026-10-10", id: "kept-late", version: 1 }),
        task("Оставленное на сегодня", { dueOn: "2026-10-17", id: "kept-today", version: 1 }),
        task("Сдать ключи", { dueOn: "2026-10-15", id: "fresh", version: 1 }),
      ]),
      rest: { repeated: new Set(["old"]), rested: new Set(["kept-late", "kept-today"]) },
    })!;
    expect(result.text).toBe("Доброе утро.\n\nСегодня · 1\n• Оставленное на сегодня\n\n⚠️ Просрочено · 1\n• Сдать ключи — срок 15.10\n\nЕщё дел · 2");
    expect(result.shownOverdue.map((shown) => shown.id)).toEqual(["fresh"]);
  });

  it("does not bring back a left-alone overdue project step as the project's line", () => {
    // Ревью 23 октября 2026: «Оставить» убирало шаг из просроченного, а строка о проекте называла его каждое утро.
    const projects = [{ completed: 0, hasNextStep: true, id: "p", open: 1, source: "Личное", status: "accepted" as const, title: "Ремонт", total: 1 }];
    const rested = formatShortDailyOverview({
      ...overview([task("Выбрать плитку", { dueOn: "2026-10-01", id: "kept", projectId: "p", version: 1 })]),
      projects, rest: { repeated: new Set(), rested: new Set(["kept"]) },
    });
    expect(rested?.text ?? "").not.toContain("Выбрать плитку");
  });

  it("marks a repeated task with 🔁 and keeps offsets right after the emoji", () => {
    const result = formatShortDailyOverview(overview([
      task("Полить цветы", { dueOn: "2026-10-17", repeat: { interval: 1, unit: "week" } }),
      task("Видео", { dueOn: "2026-10-17" }),
    ]))!;
    expect(result.text).toBe("Доброе утро.\n\nСегодня · 2\n• 🔁 Полить цветы\n• Видео");
    const bold = result.entities.map((entity) => result.text.slice(entity.offset, entity.offset + entity.length));
    expect(bold).toEqual(["Доброе утро.", "Сегодня · 2"]);
  });

  it("counts the person's own requests to others, which alone are a reason for the morning", () => {
    const result = formatShortDailyOverview({ ...overview([]), waiting: [task("Купить щёточку", { status: "proposed" })] })!;
    expect(result.text).toBe("Доброе утро. На сегодня сроков нет.\n\nТы просишь · 1");
    // «Все дела · N» равно «Открытых · N» на доске: просьбы другим туда не входят.
    expect(result.openCount).toBe(0);
  });

  it("names a week-old unanswered request to its asker and asks what to do with it (21 October 2026)", () => {
    const result = formatShortDailyOverview({ ...overview([]), waiting: [
      task("Купить зеркала в ванную", { assignee: "Юля", status: "proposed", updatedOn: "2026-10-02" }),
      task("Купить пледы", { assignee: "Юля", status: "proposed", updatedOn: "2026-10-02" }),
      task("Купить щёточку", { assignee: "Юля", status: "proposed", updatedOn: "2026-10-02" }),
      task("Свежая просьба", { assignee: "Юля", status: "proposed", updatedOn: "2026-10-16" }),
    ] })!;
    expect(result.text).toBe([
      "Доброе утро. На сегодня сроков нет.", "",
      "Без ответа неделю · 3 · показано 2", "• Купить зеркала в ванную — Юля", "• Купить пледы — Юля",
      "Напоминаю им раз в три дня. Снять или оставить? Ответь здесь.", "",
      "Ты просишь · 4",
    ].join("\n"));
  });

  it("keeps a request to the person on every morning until it is answered, apart from the five own rows", () => {
    const result = formatShortDailyOverview(overview([
      ...["А", "Б", "В", "Г", "Д"].map((title) => task(title, { dueOn: "2026-10-17" })),
      ...["Пледы", "Зеркала", "Щёточка"].map((title) => task(title, { status: "proposed", updatedOn: "2026-10-01" })),
    ]))!;
    expect(result.shown.map((shown) => shown.title)).toEqual(["А", "Б", "В", "Г", "Д"]);
    expect(result.text).toContain("Просят тебя · 3 · показано 2\n• Пледы\n• Зеркала");
  });

  it("adds one coaching line: the nearest step of a project, or a project that has no next step", () => {
    const project = (id: string, title: string, open: number, completed = 0) =>
      ({ completed, hasNextStep: open > 0, id, open, source: "Личное", status: "accepted", title, total: open + completed });
    const withStep = formatShortDailyOverview({
      ...overview([
        task("Видео", { dueOn: "2026-10-17" }),
        task("Подготовить предложение для Т-Банка", { dueOn: "2026-10-22", projectId: "gpu" }),
        task("Написать Олегу", { projectId: "gpu", updatedOn: "2026-10-04" }),
      ]),
      projects: [project("gpu", "Сделка по ГПУ", 2)],
    })!;
    expect(withStep.text).toContain("Шаг по проекту «Сделка по ГПУ»: Подготовить предложение для Т-Банка.");
    const noStep = formatShortDailyOverview({ ...overview([task("Видео", { dueOn: "2026-10-17" })]), projects: [project("flat", "Сдать квартиру", 0)] })!;
    expect(noStep.text).toContain("У проекта «Сдать квартиру» нет следующего шага. Какой он?");
  });

  it("says plainly that nothing is due today", () => {
    const result = formatShortDailyOverview(overview([task("Починить полку")]))!;
    expect(result.text).toBe("Доброе утро. На сегодня сроков нет.\n\nЕщё дел · 1");
    expect(result.shown).toEqual([]);
  });

  it("keeps quiet without a commitment and explains itself the first time", () => {
    expect(formatShortDailyOverview(overview([task("Идея", { kind: "idea" })]))).toBeNull();
    expect(formatShortDailyOverview(overview([task("Полка")]), { first: true })!.text).toContain("не пиши мне первым");
  });
});
