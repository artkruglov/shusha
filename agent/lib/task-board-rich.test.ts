import { describe, expect, it } from "vitest";

import { formatRichTaskBoard, RICH_TASK_BOARD_MAX_CHARACTERS, taskBoardReply } from "./task-board-rich.js";
import type { BoardProject, BoardTask } from "./task-board.js";

const NOW = new Date("2026-10-21T06:00:00Z");
const task = (title: string, extra: Partial<BoardTask> = {}): BoardTask => ({
  dueAt: null, dueOn: null, kind: "task", listName: null, source: "Личное", status: "accepted", title,
  updatedOn: "2026-10-20", ...extra,
});
const project = (id: string, title: string, extra: Partial<BoardProject> = {}): BoardProject => ({
  completed: 0, hasNextStep: true, id, open: 1, source: "Личное", status: "accepted", title, total: 1, ...extra,
});
const board = (tasks: readonly BoardTask[], projects?: readonly BoardProject[]) =>
  formatRichTaskBoard({ now: NOW, tasks, timezone: "Europe/Moscow", ...(projects ? { projects } : {}) })!;

describe("rich task board v3", () => {
  it("opens with today, then overdue, and folds every project into one line with its next step", () => {
    const text = board([
      task("ТО машины", { dueOn: "2026-10-21", listName: "Дом" }),
      task("Записка для облака", { dueOn: "2026-10-17", listName: "Работа" }),
      task("Написать про кластер", { listName: "Работа" }),
      task("Обновление руководству", { listName: "Работа" }),
      task("Зимние шины", { listName: "Дом" }),
    ]);

    expect(text.startsWith("### Твои дела\n\nОткрытых · 5 · Сегодня · 1\n\n")).toBe(true);
    expect(text.indexOf("**Сегодня · 1**")).toBeLessThan(text.indexOf("**⚠️ Просрочено · 1**"));
    expect(text).toContain("<details><summary>**Работа · 2** · дальше: Написать про кластер</summary>\n- Написать про кластер\n- Обновление руководству\n</details>");
    expect(text).toContain("<details><summary>**Дом · 1** · дальше: Зимние шины</summary>");
    // Сегодняшнее и просроченное не повторяются внутри проектов.
    expect(text.match(/ТО машины/gu)).toHaveLength(1);
  });

  it("names tasks that have not moved for two weeks in one line, without listing or counting reminders", () => {
    const text = board([
      task("Договориться о встрече", { listName: "Встречи", updatedOn: "2026-09-15" }),
      task("Свежая задача", { listName: "Встречи", updatedOn: "2026-10-19" }),
      task("Ничьё давнее", { listName: "Дом", source: "Семья", status: "open", updatedOn: "2026-09-01" }),
    ]);

    expect(text).toContain("Открытых · 3 · Давно без движения · 1");
    expect(text).toContain("**Давно без движения · 1**\n\nНе менялись больше двух недель.");
    expect(text).not.toContain("Скажи");
    expect(text).not.toMatch(/раз(а)? показ/u);
  });

  it("merges same-name projects of different areas and says whose each line is", () => {
    // 21 октября 2026 на доске стояли «Мы вдвоём» и «Мы вдвоём (Семья, Мы вдвоём)» рядом.
    const text = board([
      task("Спортзал вместе", { listName: "Мы вдвоём", projectId: "p-family", source: "Семья" }),
      task("План к косметологу", { listName: "Мы вдвоём", projectId: "p-own" }),
    ], [project("p-family", "Мы вдвоём", { source: "Семья" }), project("p-own", "Мы вдвоём")]);

    expect(text.match(/<summary>\*\*Мы вдвоём · 2\*\*/gu)).toHaveLength(1);
    expect(text).toContain("- Спортзал вместе · семья");
    expect(text).toContain("- План к косметологу · только мне");
  });

  it("keeps a project of one area without visibility tags and with its progress", () => {
    const text = board([task("Штора", { listName: "Переезд", projectId: "p-move" })],
      [project("p-move", "Переезд", { completed: 3, open: 1, total: 5 })]);

    expect(text).toContain("<summary>**Переезд · 1** · сделано 3 из 5 · дальше: Штора</summary>\n- Штора\n</details>");
  });

  it("puts ideas and rituals in one closing line", () => {
    const text = board([task("Дело", { listName: "Дом" }), task("Венчур", { kind: "idea" }), task("Пятничные настолки", { kind: "ritual" })]);

    expect(text.endsWith("Когда-нибудь · 1 · Традиции · 1")).toBe(true);
  });

  it("never lets a task title become markup or close its fold", () => {
    const text = board([task("</details> **жирно** [ссылка](https://x)", { listName: "Дом" })]);

    expect(text).toContain("\\</details\\> \\*\\*жирно\\*\\* \\[ссылка\\]\\(https://x\\)");
    expect(text.match(/<\/details>/gu)).toHaveLength(1);
  });

  it("drops whole projects from the end and names them when the board would be too long", () => {
    const tasks = Array.from({ length: 400 }, (_, index) =>
      task(`Дело с довольно длинным названием номер ${index + 1}`, { listName: `Проект ${String(index % 80).padStart(2, "0")}` }));
    const text = board(tasks);

    expect(text.length).toBeLessThanOrEqual(RICH_TASK_BOARD_MAX_CHARACTERS);
    expect(text).toMatch(/Не поместились: [^\n]+\. Спроси о любом отдельно\./u);
  });

  it("puts «✓» under today and overdue, «Разобрать» at the stale line, and keeps what it closed on top", () => {
    const text = formatRichTaskBoard({
      buttons: {
        closed: [{ title: "Купить хлеб", undo: "tb:undo-1" }],
        complete: new Map([["t-today", "tb:c-1"], ["t-late", "tb:c-2"]]),
        review: "https://app.example/app/#review",
      },
      now: NOW, timezone: "Europe/Moscow",
      tasks: [
        task("ТО машины <&>", { dueOn: "2026-10-21", id: "t-today", listName: "Дом" } as never),
        task("Записка", { dueOn: "2026-10-17", id: "t-late", listName: "Работа", updatedOn: "2026-09-01" } as never),
      ],
    })!;

    expect(text).toContain("**Только что закрыто · 1**\n\n- ✓ ~~Купить хлеб~~\n\n<tg-button-row><tg-button type=\"callback_data\" data=\"tb:undo-1\">↩ Вернуть · Купить хлеб</tg-button></tg-button-row>");
    expect(text).toContain("<tg-button type=\"callback_data\" data=\"tb:c-1\">✓ ТО машины &lt;&amp;&gt;</tg-button>");
    expect(text).toContain("<tg-button type=\"callback_data\" data=\"tb:c-2\">✓ Записка</tg-button>");
    expect(text).toContain("<tg-button type=\"web_app\" url=\"https://app.example/app/#review\">Разобрать</tg-button>");
    expect(text.indexOf("Только что закрыто")).toBeLessThan(text.indexOf("**Сегодня · 1**"));
  });

  it("asks nothing in words: «Беру» under a free task, «Завершить» under a finished project, «Открыть доску» at the end", () => {
    // Ревью 21 октября 2026, пункт 24: пять фраз «Скажи…» вместо кнопок.
    const text = formatRichTaskBoard({
      buttons: { claim: new Map([["t-free", "tb:claim-1"]]), complete: new Map(), finish: new Map([["p-done", "tb:fin-1"]]), open: "https://app.example/app/" },
      now: NOW, timezone: "Europe/Moscow",
      projects: [project("p-done", "Дача", { completed: 3, open: 0, total: 3 })],
      tasks: [task("Поменять лампочку", { id: "t-free", listName: "Дом", source: "Семья", status: "open" } as never), task("Без места")],
    })!;

    expect(text).not.toContain("Скажи");
    expect(text).not.toContain("Закрыть?");
    expect(text).toContain("<tg-button type=\"callback_data\" data=\"tb:claim-1\">Беру · Поменять лампочку</tg-button>");
    expect(text).toContain("<tg-button type=\"callback_data\" data=\"tb:fin-1\">Завершить · Дача</tg-button>");
    expect(text.endsWith("<tg-button-row><tg-button type=\"web_app\" url=\"https://app.example/app/\">Открыть доску</tg-button></tg-button-row>")).toBe(true);
  });

  it("shows ideas and traditions by name when they are all the board has, and names its own heading", () => {
    // Ревью 21 октября 2026: «покажи идеи» давало «Когда-нибудь · 4» без названий.
    const text = formatRichTaskBoard({ heading: "Дела семьи", now: NOW, timezone: "UTC",
      tasks: [task("Попробовать керамику", { kind: "idea" }), task("Пятничные настолки", { kind: "ritual" })] })!;

    expect(text.startsWith("### Дела семьи")).toBe(true);
    expect(text).toContain("- Попробовать керамику");
    expect(text).toContain("- Пятничные настолки");
  });

  it("escapes a person's name as it escapes a title", () => {
    const text = formatRichTaskBoard({ now: NOW, timezone: "UTC",
      tasks: [task("Забрать посылку", { assignee: "**Юля** <b>", listName: "Дом", source: "Семья", status: "proposed" })] })!;

    expect(text).toContain("Забрать посылку — \\*\\*Юля\\*\\* \\<b\\>");
  });

  it("has no buttons when none are given, as in a group", () => {
    const text = taskBoardReply([task("ТО машины", { dueOn: "2026-10-21", listName: "Дом" })], NOW, "UTC")!;
    expect(text).not.toContain("tg-button");
    expect(text).not.toContain("telegram-keep-open");
    expect(taskBoardReply([], NOW, "UTC")).toBeNull();
  });
});
