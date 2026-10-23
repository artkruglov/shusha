/**
 * Integer tuning settings.
 *
 * Constructs covered:
 * - An absent or blank variable yields the default.
 * - An integer within bounds is used as is, bounds inclusive.
 * - Anything else fails fast with one code.
 */
import { describe, expect, it } from "vitest";

import { integerSetting } from "./runtime-tuning.js";

const bounds = { absent: 7, min: 1, max: 100 };

describe("integerSetting", () => {
  it("uses the default when the variable is absent", () => {
    expect(integerSetting("X", bounds, {})).toBe(7);
  });

  it.each(["", "  "])("uses the default when the variable is %j, as compose passes an unset one", (value) => {
    expect(integerSetting("X", bounds, { X: value })).toBe(7);
  });

  it.each(["1", "42", "100"])("uses %j as is", (value) => {
    expect(integerSetting("X", bounds, { X: value })).toBe(Number(value));
  });

  it.each(["0", "101", "-1", "2.5", "ten", " 5"])("rejects %j", (value) => {
    expect(() => integerSetting("X", bounds, { X: value }))
      .toThrow(expect.objectContaining({ code: "AGENT_RUNTIME_TUNING_INVALID" }));
  });
});
