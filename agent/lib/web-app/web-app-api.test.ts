import { describe, expect, it } from "vitest";

import { postponedTo } from "./web-app-api.js";

describe("postponedTo", () => {
  it("counts today, tomorrow and the next Saturday in the person's calendar", () => {
    expect(postponedTo("2026-10-18", "today")).toBe("2026-10-18");
    // Sunday → Saturday in six days; the end of a month rolls over.
    expect(postponedTo("2026-10-18", "weekend")).toBe("2026-10-24");
    expect(postponedTo("2026-10-31", "tomorrow")).toBe("2026-11-01");
    expect(postponedTo("2026-10-21", "weekend")).toBe("2026-10-24");
    // On a Saturday «Выходные» is the next one: today is already a button of its own.
    expect(postponedTo("2026-10-24", "weekend")).toBe("2026-10-31");
  });
});
