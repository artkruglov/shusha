import { describe, expect, it } from "vitest";

import { markTelegramKeepOpen, takeTelegramKeepOpenMark } from "./telegram-keep-open-turns.js";

describe("keep-open turn mark", () => {
  it("is taken once for the turn that set it and never for another", () => {
    markTelegramKeepOpen("s1 t1");

    expect(takeTelegramKeepOpenMark("s1 t2")).toBe(false);
    expect(takeTelegramKeepOpenMark("s1 t1")).toBe(true);
    expect(takeTelegramKeepOpenMark("s1 t1")).toBe(false);
  });

  it("keeps a bounded number of marks, dropping the oldest", () => {
    for (let index = 0; index < 600; index += 1) markTelegramKeepOpen(`s t${index}`);

    expect(takeTelegramKeepOpenMark("s t0")).toBe(false);
    expect(takeTelegramKeepOpenMark("s t599")).toBe(true);
  });
});
