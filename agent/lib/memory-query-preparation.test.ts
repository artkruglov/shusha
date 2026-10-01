/**
 * Подготовка запроса памяти: обращение к ассистенту снимается, а имя как предмет вопроса остаётся;
 * эмодзи и парная разметка уходят вместе со своими знаками, слова остаются; идентификаторы с
 * подчёркиванием и точкой не принимаются за разметку; пустого запроса функция не возвращает.
 */
import { describe, expect, it } from "vitest";

import { prepareMemoryQuery } from "./memory-query-preparation.js";

const identity = { aliases: ["Шуши", "Shusha", "Shusha"], name: "Шуша" };
const prepare = (query: string) => prepareMemoryQuery(query, identity);

describe("prepareMemoryQuery", () => {
  it.each([
    ["Шуша, напомни код от домофона", "напомни код от домофона"],
    ["Шуша привет, какой у нас тариф на интернет?", "привет, какой у нас тариф на интернет?"],
    ["Слушай, Шуша, когда у Петра день рождения?", "Слушай, когда у Петра день рождения?"],
    ["@shusha_bot напомни про резину", "напомни про резину"],
    ["@shusha_bot, напомни про резину", "напомни про резину"],
  ])("removes the address in %j", (input, expected) => {
    expect(prepare(input)).toBe(expected);
  });

  it.each([
    "Где репозиторий Шуши?",
    "Что умеет Шуша в группах?",
    // Без запятой имя может быть подлежащим: слово не теряет смысла, а вырезанное теряет.
    "Шуша умеет читать PDF?",
    "шуша скажи пожалуйста где аптечка",
  ])("keeps the assistant named as the subject of the question in %j", (input) => {
    expect(prepare(input)).toBe(input);
  });

  it.each([
    "@petya какой у него телефон?",
    "Напомни, @petya, про страховку",
    "Петя, напомни про страховку",
  ])("never removes a mention of somebody else in %j", (input) => {
    expect(prepare(input)).toBe(input);
  });

  it.each([
    ["🎂 когда днюха у Алёны?", "когда днюха у Алёны?"],
    ["Напомни 🚲 номер рамы велосипеда Петра", "Напомни номер рамы велосипеда Петра"],
    ["Где ключ ❤️‍🔥 от дачи", "Где ключ от дачи"],
  ])("removes emoji from %j", (input, expected) => {
    expect(prepare(input)).toBe(expected);
  });

  it.each([
    ["**Важно**: какой код от калитки?", "Важно: какой код от калитки?"],
    ["__Срочно__ где документы на квартиру", "Срочно где документы на квартиру"],
    ["Что такое `search_vector`?", "Что такое search_vector?"],
    ["~~старое~~ новое правило про экраны", "старое новое правило про экраны"],
    ["> Напомни номер полиса", "Напомни номер полиса"],
  ])("removes Markdown from %j", (input, expected) => {
    expect(prepare(input)).toBe(expected);
  });

  it.each([
    "Что такое memory_items и чем оно отличается от memory_items_all?",
    "Ссылка https://code.example/ladoga/core ещё жива?",
    "Тикер LDGA и счётчик ХВ-118420",
  ])("leaves identifiers, links, and codes untouched in %j", (input) => {
    expect(prepare(input)).toBe(input);
  });

  it.each(["Шуша,", "@shusha_bot", "🎂"])(
    "returns the original when preparation would empty the query %j",
    (input) => {
      expect(prepare(input)).toBe(input);
    },
  );

  it("collapses the whitespace left behind by everything it removed", () => {
    expect(prepare("Шуша,   напомни    🎂   про  торт")).toBe("напомни про торт");
  });

  it("follows a differently named installation", () => {
    expect(prepareMemoryQuery("Осинара, где бэкап", { aliases: [], name: "Осинара" })).toBe("где бэкап");
    expect(prepareMemoryQuery("Шуша, где бэкап", { aliases: [], name: "Осинара" })).toBe("Шуша, где бэкап");
  });
});
