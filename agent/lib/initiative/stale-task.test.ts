import { describe, expect, it } from "vitest";

import { formatStaleTask, staleTaskButtons } from "./stale-task.js";

const task = { id: "t1", since: "2026-09-15", title: "Договориться  о встрече", version: 3 };

describe("message about a task that has not moved", () => {
  it("says since when, asks one question, and neither counts reminders nor blames", () => {
    expect(formatStaleTask(task)).toBe("«Договориться о встрече» не менялось с 15 сентября. Что с ним сделаем?");
  });

  it("offers help only while the family's model is available", () => {
    expect(staleTaskButtons(task, true).map((item) => item.action)).toEqual(["help_start", "postpone_week", "cancel", "keep"]);
    expect(staleTaskButtons(task, false).map((item) => item.action)).toEqual(["postpone_week", "cancel", "keep"]);
    expect(staleTaskButtons(task, true).every((item) => item.task?.id === "t1" && item.task.version === 3)).toBe(true);
  });
});
