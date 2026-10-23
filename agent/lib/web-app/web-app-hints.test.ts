/**
 * Подсказки Mini App: предел на человека и сутки, пауза между нажатиями, у каждого пункта каталога свой текст.
 */
import { describe, expect, it } from "vitest";

import { createHintThrottle, WEB_APP_HINTS } from "./web-app-hints.js";

describe("Mini App hints", () => {
  it("lets a person have a hint after a short gap, up to thirty a day, and counts each person apart", () => {
    const throttle = createHintThrottle();
    const start = new Date("2026-10-19T10:00:00Z");
    expect(throttle.take("a", start)).toBe(true);
    expect(throttle.take("a", new Date(start.getTime() + 500))).toBe(false);
    expect(throttle.take("b", start)).toBe(true);
    let at = start.getTime();
    let given = 1;
    for (let tap = 0; tap < 40; tap += 1) {
      at += 3_000;
      if (throttle.take("a", new Date(at))) given += 1;
    }
    expect(given).toBe(30);
    expect(throttle.take("a", new Date("2026-10-20T10:00:00Z"))).toBe(true);
  });

  it("has a text for every command and scenario the page may ask for", () => {
    for (const id of ["cmd-export", "cmd-feedback", "cmd-delete-me", "memory-edit", "grocery-cart", "connect-google", "skill-homework", "family-tradition", "family-area",
      "family-decision", "family-idea-project", "coach-on"]) {
      expect(WEB_APP_HINTS[id]).toBeTruthy();
    }
    expect(WEB_APP_HINTS["cmd-export"]).toContain("/export");
  });
});
