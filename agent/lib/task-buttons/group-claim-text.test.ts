/** «… берёт: …» lines under the group overview: appended once, merged across presses, nothing when unchanged. */
import { describe, expect, it } from "vitest";

import { claimedMessageText, claimLine } from "./group-claim-text.js";

const overview = "Доброе утро! Общие дела семьи на сегодня.\n\nНичьи\n• Купить щёточку\n• Заказать фильтры";

describe("group claim text", () => {
  it("appends the line below the overview", () => {
    expect(claimedMessageText(overview, [claimLine("Юля", "Купить щёточку")]))
      .toBe(`${overview}\n\n✋ Юля берёт: Купить щёточку`);
  });

  it("keeps lines already on screen and adds new ones once, in order", () => {
    const first = claimedMessageText(overview, [claimLine("Юля", "Купить щёточку")])!;
    expect(claimedMessageText(first, [claimLine("Артём", "Заказать фильтры"), claimLine("Юля", "Купить щёточку")]))
      .toBe(`${overview}\n\n✋ Юля берёт: Купить щёточку\n✋ Артём берёт: Заказать фильтры`);
  });

  it("says there is nothing to edit when every line is already shown or none is known", () => {
    const first = claimedMessageText(overview, [claimLine("Юля", "Купить щёточку")])!;
    expect(claimedMessageText(first, [claimLine("Юля", "Купить щёточку")])).toBeNull();
    expect(claimedMessageText(overview, [])).toBeNull();
  });

  it("names a long task briefly and leaves the text alone when it would not fit in a message", () => {
    expect(claimLine("Юля", "а".repeat(1000))).toBe(`✋ Юля берёт: ${"а".repeat(59)}…`);
    const long = `${"x".repeat(4080)}`;
    expect(claimedMessageText(long, [claimLine("Юля", "Купить щёточку")])).toBeNull();
  });
});
