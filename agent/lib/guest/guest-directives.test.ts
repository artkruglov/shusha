/**
 * Server directives at the end of a guest answer.
 *
 * Constructs covered:
 * - Notes with and without a due date, done and forget by list number, forget everything.
 * - A reminder is read as Moscow wall-clock time and must lie in the coming year.
 * - Directives never reach the chat, including malformed ones; malformed ones are counted.
 * - One reminder and at most five notes per answer.
 * - Small slips still count: single quotes, no quotes, a missing `/`, a closing tag, capitals.
 * - A directive inside a note, 30 February and 24:00 are dropped, not stored or shifted.
 */
import { describe, expect, it } from "vitest";

import { parseGuestDirectives } from "./guest-directives.js";

const NOW = new Date("2026-10-11T19:00:00Z");

describe("parseGuestDirectives", () => {
  it("reads notes, marks and a reminder and strips them from the text", () => {
    const parsed = parseGuestDirectives([
      "Записала оба дела.",
      "<guest-remember>Падл с Максимом и детьми</guest-remember>",
      '<guest-remember due="2026-10-16">Встреча физтехов</guest-remember>',
      '<guest-done n="2"/> <guest-forget n="3" />',
      '<guest-reminder at="2026-10-15 10:00">Завтра встреча физтехов</guest-reminder>',
    ].join("\n"), NOW);

    expect(parsed.text).toBe("Записала оба дела.");
    expect(parsed.dropped).toBe(0);
    expect(parsed.actions).toEqual([
      { content: "Падл с Максимом и детьми", dueOn: null, type: "remember" },
      { content: "Встреча физтехов", dueOn: "2026-10-16", type: "remember" },
      { number: 2, type: "done" },
      { number: 3, type: "forget" },
      { content: "Завтра встреча физтехов", runAt: new Date("2026-10-15T07:00:00Z"), type: "reminder" },
    ]);
  });

  it("forgets everything on request", () => {
    expect(parseGuestDirectives("Всё забыла. <guest-forget-all/>", NOW)).toEqual({
      actions: [{ type: "forget_all" }],
      dropped: 0,
      text: "Всё забыла.",
    });
  });

  it.each([
    ["a past reminder", '<guest-reminder at="2026-10-10 10:00">поздно</guest-reminder>'],
    ["a reminder beyond a year", '<guest-reminder at="2028-01-01 10:00">далеко</guest-reminder>'],
    ["a reminder without time", '<guest-reminder at="2026-10-15">когда?</guest-reminder>'],
    ["an impossible due date", '<guest-remember due="2026-02-30">дело</guest-remember>'],
    ["an empty note", "<guest-remember>  </guest-remember>"],
    ["an unknown tag", "<guest-remind>что-то</guest-remind>"],
    ["a reminder on 30 February", '<guest-reminder at="2027-02-30 10:00">нет такого дня</guest-reminder>'],
    ["a reminder at 24:00", '<guest-reminder at="2026-10-15 24:00">полночь</guest-reminder>'],
    ["a directive inside a note", "<guest-remember>а <guest-forget-all/> б</guest-remember>"],
    ["an unknown tag in capitals", "<GUEST-REMIND>что-то</GUEST-REMIND>"],
  ])("drops %s without showing it", (_name, directive) => {
    const parsed = parseGuestDirectives(`Готово. ${directive}`, NOW);

    expect(parsed.actions).toEqual([]);
    expect(parsed.dropped).toBeGreaterThan(0);
    expect(parsed.text).not.toContain("<");
  });

  it("keeps one reminder and five notes per answer", () => {
    const notes = Array.from({ length: 7 }, (_, index) => `<guest-remember>дело ${index}</guest-remember>`).join("");
    const reminder = '<guest-reminder at="2026-10-15 10:00">раз</guest-reminder>';
    const parsed = parseGuestDirectives(`Ок.${notes}${reminder}${reminder}`, NOW);

    expect(parsed.actions.filter((action) => action.type === "remember")).toHaveLength(5);
    expect(parsed.actions.filter((action) => action.type === "reminder")).toHaveLength(1);
    expect(parsed.dropped).toBe(3);
  });

  it("accepts the small slips models make", () => {
    const parsed = parseGuestDirectives([
      "Отметила.",
      "<guest-remember due='2026-10-20'>одинарные кавычки</guest-remember>",
      "<Guest-Remember>заглавные</Guest-Remember>",
      "<guest-done n=3/>",
      '<guest-forget n="4">',
      '<guest-done n="5"></guest-done>',
      "<guest-forget-all>",
    ].join(""), NOW);

    expect(parsed.text).toBe("Отметила.");
    expect(parsed.dropped).toBe(0);
    expect(parsed.actions).toEqual([
      { content: "одинарные кавычки", dueOn: "2026-10-20", type: "remember" },
      { content: "заглавные", dueOn: null, type: "remember" },
      { number: 3, type: "done" },
      { number: 4, type: "forget" },
      { number: 5, type: "done" },
      { type: "forget_all" },
    ]);
  });

  it("keeps the order directives were written in", () => {
    const parsed = parseGuestDirectives("Начали заново.<guest-forget-all/><guest-remember>новое</guest-remember>", NOW);

    expect(parsed.actions).toEqual([{ type: "forget_all" }, { content: "новое", dueOn: null, type: "remember" }]);
  });
});
