/**
 * Утренний разбор семейных дел в группе: говорит только когда есть обязательство, называет, кому
 * поручено сегодняшнее, просроченное без имени, и не выдаёт личное.
 */
import { describe, expect, it } from "vitest";

import { formatGroupOverview, type GroupOverviewTask } from "./group-overview.js";

const NOW = new Date("2026-09-29T06:00:00Z");
const task = (extra: Partial<GroupOverviewTask> = {}): GroupOverviewTask => ({
  assigneeName: null, dueAt: null, dueOn: null, kind: "task", lifeArea: null, listName: "Дом",
  source: "Семейное", status: "accepted", title: "Купить хлеб", ...extra,
});
const overview = (tasks: GroupOverviewTask[]) => ({ now: NOW, tasks, timezone: "Europe/Moscow" });

describe("formatGroupOverview", () => {
  it("stays silent when the family has nothing to commit to", () => {
    expect(formatGroupOverview(overview([]))).toBeNull();
    // Идея и традиция обещаний не создают: одни они утреннего сообщения не вызывают.
    expect(formatGroupOverview(overview([task({ kind: "idea" }), task({ kind: "ritual" })]))).toBeNull();
    expect(formatGroupOverview(overview([task({ status: "done" })]))).toBeNull();
  });

  it("shows today with names, overdue without a name, the free ones and one next step per project", () => {
    // Ревью 21 октября 2026, пункт 8: не вся доска с именем у каждой строки и упрёком при маме и ребёнке.
    const text = formatGroupOverview(overview([
      task({ assigneeName: "Артём", dueOn: "2026-09-29", listName: "Дом", title: "Позвонить маме" }),
      task({ assigneeName: "Артём", dueOn: "2026-09-18", listName: "Кружки", title: "Оплатить кружок" }),
      task({ status: "open", title: "Поменять лампочку" }),
      task({ assigneeName: "Артём", listName: "Отпуск", title: "Сравнить отели" }),
      task({ assigneeName: "Юля", listName: "Отпуск", title: "Оформить загранпаспорт" }),
      task({ assigneeName: "Юля", status: "proposed", title: "Забрать посылку" }),
    ]))!;

    expect(text).toContain("Сегодня · 1\n• Артём: Позвонить маме");
    expect(text).toContain("⚠️ Просрочено · 1\n• Оплатить кружок — с 18.09");
    expect(text).not.toContain("Артём: Оплатить кружок");
    expect(text).toContain("Никто не взял · 1\n• Поменять лампочку");
    expect(text).toContain("Шаги проектов · 1\n• Отпуск: Артём: Сравнить отели");
    expect(text).not.toContain("Оформить загранпаспорт");
    expect(text).not.toContain("Скажи");
    expect(text).toContain("Открытых · 6. Всё целиком по кнопке «Все дела», своё по «Мои дела».");
  });

  it("keeps each section short and does not break past one Telegram message", () => {
    const many = Array.from({ length: 80 }, (_, index) => task({ dueOn: "2026-09-29", listName: `Список ${index}`, title: `Дело ${index}` }));
    const text = formatGroupOverview(overview(many))!;

    expect(text).toContain("Сегодня · 80 · показано 5");
    expect(text.length).toBeLessThanOrEqual(4096);
  });

  it("explains itself only the first time", () => {
    expect(formatGroupOverview(overview([task()]), { first: true })).toContain("общий утренний обзор");
    expect(formatGroupOverview(overview([task()]))).not.toContain("общий утренний обзор");
  });

  it("carries no markup that a task title could inject into the group", () => {
    const text = formatGroupOverview(overview([task({ title: "**жирный** [ссылка](http://x)" })]))!;

    expect(text).toContain("**жирный**");
    expect(text).not.toMatch(/\\\*|\\\[/u);
  });
});
