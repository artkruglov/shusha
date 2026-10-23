import { describe, expect, it } from "vitest";

import { markTurnBoard, takeTurnBoard } from "./telegram-turn-board.js";

const board = (text: string) => ({ markdown: `**${text}**` });

describe("turn board", () => {
  it("is taken once for the turn that set it and never for another", () => {
    markTurnBoard("s1 t1", board("Дом"));

    expect(takeTurnBoard("s1 t2")).toBeNull();
    expect(takeTurnBoard("s1 t1")).toEqual(board("Дом"));
    expect(takeTurnBoard("s1 t1")).toBeNull();
  });

  it("keeps the last board of a turn that read twice", () => {
    markTurnBoard("s2 t1", board("Старое"));
    markTurnBoard("s2 t1", board("Новое"));

    expect(takeTurnBoard("s2 t1")?.markdown).toBe("**Новое**");
  });

  it("keeps a bounded number of boards, dropping the oldest", () => {
    for (let index = 0; index < 600; index += 1) markTurnBoard(`s t${index}`, board(String(index)));

    expect(takeTurnBoard("s t0")).toBeNull();
    expect(takeTurnBoard("s t599")?.markdown).toBe("**599**");
  });
});
