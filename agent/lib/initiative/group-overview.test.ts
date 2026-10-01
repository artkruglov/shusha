/**
 * Утренний разбор семейных дел в группе: говорит только когда есть обязательство, называет, кому
 * оно поручено, и не выдаёт личное.
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

  it("names who each task belongs to and marks the free and the waiting ones", () => {
    const text = formatGroupOverview(overview([
      task({ assigneeName: "Юля", title: "Записаться к врачу" }),
      task({ status: "open", title: "Заказать корзину" }),
      task({ assigneeName: "Юля", status: "proposed", title: "Забрать посылку" }),
    ]))!;

    expect(text).toContain("Юля: Записаться к врачу");
    expect(text).toContain("Ничьи · 1\n• Заказать корзину");
    expect(text).toContain("Ждут согласия · 1\n• Юля: Забрать посылку");
  });

  it("puts what is overdue first and does not break past one Telegram message", () => {
    const many = Array.from({ length: 80 }, (_, index) => task({ listName: `Список ${index}`, title: `Дело ${index}` }));
    const text = formatGroupOverview(overview([task({ dueOn: "2026-09-20", title: "Просроченное" }), ...many]))!;

    expect(text.indexOf("Просрочено")).toBeLessThan(text.indexOf("Список"));
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
