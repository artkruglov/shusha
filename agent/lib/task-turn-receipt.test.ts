/**
 * When the receipt of closed tasks goes out by itself.
 *
 * Constructs covered:
 * - A deliberate silence of a person's turn sends it alone; held text (the answer carries it), an
 *   empty step that is no silence and a scheduled run do not.
 * - The format: nothing changed means no line; a long list is cut with «и ещё N».
 */
import { describe, expect, it } from "vitest";

import { formatTaskTurnReceipt, receiptGoesAlone } from "./task-turn-receipt.js";

const turn = { deliberateSilence: true, scheduled: false, textHeld: false };

describe("task turn receipt", () => {
  it("goes alone only when a person's silent turn has no text to carry it", () => {
    expect(receiptGoesAlone(turn)).toBe(true);
    expect(receiptGoesAlone({ ...turn, textHeld: true })).toBe(false);
    expect(receiptGoesAlone({ ...turn, deliberateSilence: false })).toBe(false);
    expect(receiptGoesAlone({ ...turn, scheduled: true })).toBe(false);
  });

  it("formats nothing for no change and cuts a long list", () => {
    expect(formatTaskTurnReceipt({ cancelled: [], completed: [] })).toBeNull();
    const many = Array.from({ length: 14 }, (_, index) => `Дело ${index + 1}`);
    expect(formatTaskTurnReceipt({ cancelled: [], completed: many })).toMatch(/^✓ Закрыто: Дело 1; .*Дело 12 и ещё 2$/);
  });
});
