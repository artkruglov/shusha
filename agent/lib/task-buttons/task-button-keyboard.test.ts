/**
 * Task button labels, callback data and the keyboard edit after a press.
 *
 * Constructs covered:
 * - The data is `tb:<uuid>` within Telegram's 64 bytes; anything else is not a task button.
 * - A long title with emoji is cut on a code point, not in the middle of a surrogate pair.
 * - Every task button is redrawn from its database state; a removed one goes with its emptied row.
 * - The keyboard is read from the raw update and a malformed one is ignored.
 */
import { describe, expect, it } from "vitest";

import { parseTaskButtonCallbackData, taskButtonCallbackData } from "./task-button-callback-data.js";
import { messageKeyboard, resolvedKeyboard, taskButtonLabel } from "./task-button-keyboard.js";

const ID = "0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

describe("task button keyboard", () => {
  it("writes and reads only its own callback data", () => {
    const data = taskButtonCallbackData(ID);
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    expect(parseTaskButtonCallbackData(data)).toBe(ID);
    expect(parseTaskButtonCallbackData("gr:" + ID)).toBeNull();
    expect(parseTaskButtonCallbackData(`${data}x`)).toBeNull();
    expect(() => taskButtonCallbackData("1; DROP")).toThrow(/AGENT_TASK_BUTTON_ID_INVALID/u);
  });

  it("cuts a long title on a code point", () => {
    expect(taskButtonLabel("✓", "Купить  хлеб\n")).toBe("✓ Купить хлеб");
    const label = taskButtonLabel("✓", `Проверить homework ${"📚".repeat(20)}`);
    expect(Array.from(label)).toHaveLength(32);
    expect(label.endsWith("…")).toBe(true);
    expect(label.slice(-2, -1)).toBe("📚".slice(1)); // the last kept emoji is whole
  });

  it("redraws every task button from its state and drops a removed one with its row", () => {
    const A = "aaaaaaaa-0000-4000-8000-000000000001", B = "aaaaaaaa-0000-4000-8000-000000000002";
    const Z = "aaaaaaaa-0000-4000-8000-000000000009";
    const keyboard = [
      [{ callback_data: `tb:${A}`, text: "✓ А" }, { callback_data: `tb:${B}`, text: "✓ Б" }],
      [{ callback_data: "tb:unknown", text: "Чужая" }],
      [{ text: "Сайт", url: "https://example.org" }],
    ];
    const states = new Map([[A, { action: "reopen", id: Z, title: "Купить хлеб" }], [B, null]]);
    expect(resolvedKeyboard(keyboard, states, parseTaskButtonCallbackData, taskButtonCallbackData)).toEqual([
      [{ callback_data: `tb:${Z}`, text: "↩ Вернуть · Купить хлеб" }],
      [{ callback_data: "tb:unknown", text: "Чужая" }],
      [{ text: "Сайт", url: "https://example.org" }],
    ]);
  });

  it("reads the keyboard from the raw update", () => {
    const rows = [[{ callback_data: "tb:a", text: "✓ А" }]];
    expect(messageKeyboard({ message: { reply_markup: { inline_keyboard: rows } } })).toEqual(rows);
    expect(messageKeyboard({ message: { reply_markup: { inline_keyboard: [[{ data: 1 }]] } } })).toBeNull();
    expect(messageKeyboard({})).toBeNull();
  });
});
