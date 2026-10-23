/** The home screen's greeting follows the person's own hour. */
import { describe, expect, it } from "vitest";

import { greetingOf } from "./web-app-home.js";

describe("Mini App home greeting", () => {
  it("greets by the part of the person's day", () => {
    expect(greetingOf(7)).toEqual({ greeting: "Доброе утро", partOfDay: "morning" });
    expect(greetingOf(12)).toEqual({ greeting: "Добрый день", partOfDay: "day" });
    expect(greetingOf(19)).toEqual({ greeting: "Добрый вечер", partOfDay: "evening" });
    expect(greetingOf(2)).toEqual({ greeting: "Доброй ночи", partOfDay: "night" });
    expect(greetingOf(23)).toEqual({ greeting: "Доброй ночи", partOfDay: "night" });
  });
});
