/**
 * Строка «куда записано»: код называет место записи, а не модель. Прод 29 сентября 2026: 21 из 56
 * открытых дел лежали без списка, и человек не знал, куда бот «накинул» сказанное.
 */
import { describe, expect, it } from "vitest";

import { describeAdoptedClosures, describeFiling, type FiledTask } from "./task-filing.js";

const TZ = "Europe/Moscow";
const task = (extra: Partial<FiledTask> = {}): FiledTask => ({
  assignee: "Анна", dueAt: null, dueOn: null, kind: "task", lifeArea: null, listName: null,
  scope: "personal", status: "accepted", title: "Купить батарейки", ...extra,
});

describe("describeFiling", () => {
  it("names the list, the deadline and who sees it", () => {
    const { filed } = describeFiling([task({ dueOn: "2026-10-03", listName: "Дом" })], TZ);

    expect(filed).toBe("• «Купить батарейки» → список «Дом», срок 03.10, видишь только ты");
  });

  it("says plainly that a task has no list yet", () => {
    expect(describeFiling([task({ title: "Разобраться с кружком" })], TZ).filed)
      .toBe("• «Разобраться с кружком» → пока без списка, без срока, видишь только ты");
  });

  it("shows the life area by its human name", () => {
    expect(describeFiling([task({ lifeArea: "self", listName: "Здоровье" })], TZ).filed)
      .toContain("Для себя, список «Здоровье»");
  });

  it("marks a free family task and a proposal in one word and says the rest once under the list", () => {
    const free = describeFiling([task({ assignee: null, scope: "family", status: "open" })], TZ).filed;
    const proposed = describeFiling([task({ assignee: "Юля", scope: "family", status: "proposed" })], TZ).filed;

    expect(free.split("\n")).toEqual([
      "• «Купить батарейки» → пока без списка, без срока, ничьё, видит вся семья",
      "Ничьи дела никто не взял: скажи «беру» или назови, кому.",
    ]);
    expect(proposed.split("\n")).toEqual([
      "• «Купить батарейки» → пока без списка, без срока, ждёт согласия: Юля, видит вся семья",
      "Ждут согласия: Юля. Пока ответа нет, дело не назначено.",
    ]);
  });

  it("does not repeat the unowned warning for every line of a batch", () => {
    const many = Array.from({ length: 3 }, (_, i) => task({ assignee: null, scope: "family", status: "open", title: `Дело ${i + 1}` }));
    const lines = describeFiling(many, TZ).filed.split("\n");

    expect(lines).toHaveLength(4);
    expect(lines.filter((line) => line.includes("никто не взял"))).toHaveLength(1);
  });

  it("adds no warning for a personal task or for one somebody already owns", () => {
    expect(describeFiling([task({ scope: "family", status: "accepted" }), task({ status: "accepted" })], TZ).filed)
      .not.toMatch(/никто не взял|Ждут согласия/u);
  });

  it("names the unowned tasks that a closure just assigned, without gendered verbs or a bare 'you'", () => {
    expect(describeAdoptedClosures([{ title: "Встретить мебельщиков", assignee: "Анна" }]))
      .toBe("Было ничьё, никто не брал: «Встретить мебельщиков». Закрыто, исполнитель: Анна.");
    expect(describeAdoptedClosures([{ title: "А", assignee: "Анна" }, { title: "Б", assignee: "Анна" }]))
      .toBe("Были ничьими, никто не брал: «А», «Б». Закрыты, исполнитель: Анна.");
    expect(describeAdoptedClosures([])).toBeNull();
    const many = describeAdoptedClosures(Array.from({ length: 9 }, (_, i) => ({ title: `Дело ${i + 1}`, assignee: "Анна" })))!;
    expect(many).toContain("«Дело 6»");
    expect(many).not.toContain("«Дело 7»");
    expect(many).toContain("…и ещё 3");
  });

  it("files an idea under someday and a tradition as a tradition, never as an obligation", () => {
    expect(describeFiling([task({ kind: "idea", title: "Керамика" })], TZ).filed)
      .toBe("• «Керамика» → идея, «Когда-нибудь», видишь только ты");
    expect(describeFiling([task({ kind: "ritual", title: "Чай по воскресеньям", scope: "family" })], TZ).filed)
      .toBe("• «Чай по воскресеньям» → традиция, видит вся семья");
  });

  it("keeps a batch to a few lines and says how many it left out", () => {
    const many = Array.from({ length: 9 }, (_, index) => task({ listName: "Дом", title: `Дело ${index + 1}` }));
    const { filed } = describeFiling(many, TZ);

    expect(filed.split("\n")).toHaveLength(7);
    expect(filed.split("\n").at(-1)).toBe("…и ещё 3");
  });

  it("cannot turn a title into markup", () => {
    expect(describeFiling([task({ title: "**жирный** [x](http://e)" })], TZ).filed).toContain("«**жирный** [x](http://e)»");
  });
});
