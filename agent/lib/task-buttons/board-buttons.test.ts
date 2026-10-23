import type { TelegramCallbackQuery } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { isRichBoardPress, redrawBoard, richBoardButtonIds } from "./board-buttons.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const UNDO = "33333333-3333-4333-8333-333333333333";

function query(rich: unknown): TelegramCallbackQuery {
  return {
    data: `tb:${A}`, from: { id: "700101", isBot: false }, id: "q",
    message: { chat: { id: "700101", type: "private" }, messageId: "55" },
    raw: { message: { message_id: 55, rich_message: rich } },
  };
}
const rich = { blocks: [{ type: "list", items: [{ blocks: [] }] }, { type: "buttons", buttons: [
  { callback_data: `tb:${A}`, text: { text: "✓ Хлеб" } }, { callback_data: "probe:x", text: { text: "x" } },
] }, { type: "details", blocks: [{ type: "buttons", buttons: [{ callback_data: `tb:${B}`, text: { text: "✓ Шины" } }] }] }] };

describe("board with «✓» inside its text", () => {
  it("finds every task button of a rich message, also inside a folded block", () => {
    expect(richBoardButtonIds(query(rich).raw)).toEqual([A, B]);
    expect(isRichBoardPress(query(rich))).toBe(true);
    expect(isRichBoardPress({ ...query(rich), raw: { message: { text: "x" } } })).toBe(false);
  });

  it("reads the same board again and keeps what its buttons closed, and is still closed, on top with their undo", async () => {
    const board = vi.fn().mockResolvedValue("доска");
    const edit = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockResolvedValue({ tasks: [], timezone: "UTC" });
    const retire = vi.fn().mockResolvedValue(undefined);
    const today = { filters: { view: "today" }, source: "list" as const };
    await redrawBoard({
      board, edit, now: () => new Date("2026-10-21T09:00:00Z"), read, retire,
      resolve: async () => new Map([
        [A, { action: "reopen", id: UNDO, status: "completed", title: "Хлеб" }],
        [B, { action: "reopen", id: B, status: "accepted", title: "Шины" }],
      ]),
    }, { familyId: "f", groupId: null, telegramUserId: "700101" } as never, query(rich), { boardQuery: today } as never);

    // Ревью 21 октября 2026: перерисовка «на сегодня» оставалась «на сегодня», а не всей доской.
    expect(read).toHaveBeenCalledWith(expect.anything(), today);
    // «Шины» открыли снова в чате: наверху их нет.
    expect(board).toHaveBeenCalledWith(expect.objectContaining({ closed: [{ title: "Хлеб", undo: `tb:${UNDO}` }], query: today }));
    expect(edit).toHaveBeenCalledWith({ chatId: "700101", markdown: "доска", messageId: "55" });
    expect(retire).toHaveBeenCalledWith([B]);
  });

  it("leaves the old board when the redraw fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const edit = vi.fn();
    await redrawBoard({
      board: vi.fn(), edit, now: () => new Date(), read: vi.fn().mockRejectedValue(new Error("down")),
      resolve: async () => new Map(), retire: vi.fn(),
    }, {} as never, query(rich), { boardQuery: null } as never);
    expect(edit).not.toHaveBeenCalled();
  });
});
