/**
 * Подписи повторов на экране «Напоминания»: дни недели так, как их говорят люди.
 */
import { describe, expect, it } from "vitest";

import { repeatLabel } from "./web-app-routines.js";

const NEXT = "2026-10-21T06:00:00Z";
const weekly = (daysOfWeek: number[], interval = 1) => repeatLabel({ daysOfWeek, interval, unit: "weekly" }, NEXT, "Europe/Moscow");

describe("Mini App routine labels", () => {
  it("names weekdays and weekends in a word and lists the rest with commas", () => {
    expect(weekly([1, 2, 3, 4, 5])).toBe("По будням в 9:00");
    expect(weekly([6, 0])).toBe("По выходным в 9:00");
    expect(weekly([5, 1, 3])).toBe("По понедельникам, средам и пятницам в 9:00");
    expect(weekly([2], 2)).toBe("Раз в 2 недели, по вторникам в 9:00");
    expect(weekly([0, 1, 2, 3, 4, 5, 6])).toBe("Каждый день в 9:00");
  });
});
