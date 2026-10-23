/**
 * «Закрытые за неделю»: неделя с понедельника, подпись диапазона, сделанное и снятое отдельно, «Вернуть» только
 * у своего обычного дела.
 */
import { describe, expect, it } from "vitest";

import { webAppClosedWeek, weekOf, type ClosedCandidate } from "./web-app-closed.js";

const base: Omit<ClosedCandidate, "action" | "taskId"> = {
  actorTelegramId: "101", assigneeTelegramId: "101", at: new Date("2026-10-16T10:00:00Z"), creatorTelegramId: "101", repeat: false,
};

describe("Mini App closed week", () => {
  it("runs from Monday to Sunday", () => {
    expect(weekOf("2026-10-16")).toEqual({ from: "2026-10-12", until: "2026-10-18" });
    expect(weekOf("2026-10-12")).toEqual({ from: "2026-10-12", until: "2026-10-18" });
    expect(weekOf("2026-11-01")).toEqual({ from: "2026-10-26", until: "2026-11-01" });
  });

  it("splits done from removed, newest first, and offers «Вернуть» only where it may work", () => {
    const week = webAppClosedWeek(weekOf("2026-10-16"), [
      { ...base, action: "complete", at: new Date("2026-10-13T10:00:00Z"), taskId: "a" },
      { ...base, action: "complete", taskId: "b" },
      { ...base, action: "complete", repeat: true, taskId: "c" },
      { ...base, action: "cancel", actorTelegramId: "102", assigneeTelegramId: "102", creatorTelegramId: "102", taskId: "d" },
      { ...base, action: "complete", taskId: "hidden" },
    ], new Map([
      ["a", { title: "Отправить документы", version: 4 }], ["b", { title: "Подготовить видео", version: 2 }],
      ["c", { title: "Полить цветы", version: 9 }], ["d", { title: "Лишнее", version: 3 }],
    ]), { names: new Map([["101", "Артём"], ["102", "Юля"]]), timezone: "Europe/Moscow", viewerTelegramId: "101" });

    expect(week.label).toBe("12–18 октября");
    expect(week.done.map((row) => [row.title, row.canReopen])).toEqual([
      ["Подготовить видео", true], ["Полить цветы", false], ["Отправить документы", true],
    ]);
    expect(week.done[0]!.detail).toBe("Артём · 16 октября");
    expect(week.cancelled).toEqual([expect.objectContaining({ canReopen: false, detail: "Юля · 16 октября", title: "Лишнее" })]);
    expect(webAppClosedWeek(weekOf("2026-10-30"), [], new Map(), { names: new Map(), timezone: "UTC", viewerTelegramId: "1" }).label)
      .toBe("26 октября – 1 ноября");
  });
});
