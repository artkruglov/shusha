import { describe, expect, it } from "vitest";

import { splitShoppingLine } from "./shopping-line.js";

describe("splitShoppingLine", () => {
  it("divides a list by commas, semicolons and line breaks", () => {
    expect(splitShoppingLine("молоко, хлеб, яйца")).toEqual(["молоко", "хлеб", "яйца"]);
    expect(splitShoppingLine("хлеб; молоко")).toEqual(["хлеб", "молоко"]);
    expect(splitShoppingLine("хлеб\nмолоко\n\n")).toEqual(["хлеб", "молоко"]);
    expect(splitShoppingLine(" , хлеб ,, ")).toEqual(["хлеб"]);
  });

  it("keeps a decimal comma inside a number", () => {
    expect(splitShoppingLine("Молоко 3,2 %")).toEqual(["Молоко 3,2 %"]);
    expect(splitShoppingLine("Вода 1,5 л x6")).toEqual(["Вода 1,5 л x6"]);
    expect(splitShoppingLine("Молоко 3,2 %, хлеб")).toEqual(["Молоко 3,2 %", "хлеб"]);
  });

  it("keeps a comma before a quantity with a unit", () => {
    expect(splitShoppingLine("Сметана 20%, 2 банки")).toEqual(["Сметана 20%, 2 банки"]);
    expect(splitShoppingLine("Сыр, 300 г")).toEqual(["Сыр, 300 г"]);
    expect(splitShoppingLine("Картошка, 1 кг")).toEqual(["Картошка, 1 кг"]);
    expect(splitShoppingLine("Яйца, 2 шт")).toEqual(["Яйца, 2 шт"]);
    expect(splitShoppingLine("Вода, 1,5 л")).toEqual(["Вода, 1,5 л"]);
    expect(splitShoppingLine("Сметана 20%, 2 банки, хлеб, яйца, 10 шт")).toEqual(["Сметана 20%, 2 банки", "хлеб", "яйца, 10 шт"]);
  });

  it("still divides before a number that is not a quantity", () => {
    expect(splitShoppingLine("молоко, 2 гвоздики")).toEqual(["молоко", "2 гвоздики"]);
    expect(splitShoppingLine("хлеб, 7 up")).toEqual(["хлеб", "7 up"]);
  });
});
