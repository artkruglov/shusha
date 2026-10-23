/**
 * The published text of a guest answer's provider result.
 *
 * Constructs covered:
 * - Only the text after the last search is published; the preamble before it is dropped (11 October
 *   2026: «…проиндексирован.Проверила:…»).
 * - Without a search the whole text is the answer.
 * - A search with no text after it gives an empty answer, which the answerer turns into a failure.
 * - Failed searches are counted apart from executed ones.
 * - An answer cut at the token limit is a failure, not a published half-sentence.
 */
import type { LanguageModelV4Content, LanguageModelV4FinishReason } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { guestTextFromContent } from "./guest-model.js";

const stop: LanguageModelV4FinishReason = { raw: "end_turn", unified: "stop" };

function search(id: string, isError = false): LanguageModelV4Content[] {
  return [
    { input: "{}", providerExecuted: true, toolCallId: id, toolName: "web_search", type: "tool-call" },
    { isError, result: [], toolCallId: id, toolName: "web_search", type: "tool-result" },
  ];
}

describe("guestTextFromContent", () => {
  it("publishes only the text after the last search", () => {
    const result = guestTextFromContent([
      { text: "Про канал: посмотрю через веб-поиск.", type: "text" },
      ...search("s1"),
      { text: "Ищу ещё.", type: "text" },
      ...search("s2"),
      { text: "Проверила: канал не индексируется.", type: "text" },
    ], stop);

    expect(result).toEqual({ searchErrors: 0, searches: 2, text: "Проверила: канал не индексируется." });
  });

  it("keeps the whole text when there was no search", () => {
    expect(guestTextFromContent([
      { text: "Привет", type: "text" },
      { text: ", Артём!", type: "text" },
    ], stop).text).toBe("Привет, Артём!");
  });

  it("gives no text when the model stopped right after a search", () => {
    expect(guestTextFromContent([{ text: "Сейчас поищу.", type: "text" }, ...search("s1")], stop).text).toBe("");
  });

  it("counts failed searches apart", () => {
    expect(guestTextFromContent([...search("s1", true), { text: "Не нашла.", type: "text" }], stop))
      .toMatchObject({ searchErrors: 1, searches: 1 });
  });

  it("refuses an answer cut at the token limit", () => {
    expect(() => guestTextFromContent([{ text: "Взрослый билет стоит", type: "text" }], {
      raw: "max_tokens",
      unified: "length",
    })).toThrow(expect.objectContaining({ code: "AGENT_GUEST_ANSWER_TRUNCATED" }));
  });
});
