/**
 * The single model request behind a guest answer.
 *
 * Exports:
 * - `generateGuestText`: one physical provider request with DeepSeek's server-side web search; returns
 *   the text and how many searches the provider ran and how many of them failed (logged, so a
 *   made-up «выдача» shows).
 * - `guestTextFromContent`: the published text of a provider result; tested without a provider.
 *
 * Search is offered, not forced: «переведи» needs none, «сколько стоит» does. The number of searches
 * is not capped (owner decision of 14 September 2026); the daily guest ceiling bounds the cost.
 *
 * Only the text after the last search is published. What the model wrote before a search is a
 * preamble («посмотрю через поиск…») that the result may contradict, and joining it to the answer
 * glued two messages into one («…проиндексирован.Проверила:…», 11 October 2026).
 */
import type { LanguageModelV4, LanguageModelV4Content, LanguageModelV4FinishReason } from "@ai-sdk/provider";

import { AppError } from "../app-error.js";
import type { GuestChatNote } from "./guest-chat-repository.js";
import { guestSystemPrompt, guestUserPrompt, type GuestMessage } from "./guest-message.js";

const GUEST_MODEL_TIMEOUT_MS = 90_000;
const GUEST_MAX_OUTPUT_TOKENS = 2_048;

export interface GuestText {
  readonly searchErrors: number;
  readonly searches: number;
  readonly text: string;
}

function isSearchPart(part: LanguageModelV4Content): boolean {
  return (part.type === "tool-call" || part.type === "tool-result") && part.toolName === "web_search";
}

function lastSearchIndex(content: readonly LanguageModelV4Content[]): number {
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (isSearchPart(content[index]!)) return index;
  }
  return -1;
}

export function guestTextFromContent(
  content: readonly LanguageModelV4Content[],
  finishReason: LanguageModelV4FinishReason,
): GuestText {
  if (finishReason.unified === "length") {
    throw new AppError("AGENT_GUEST_ANSWER_TRUNCATED", "Гостевой ответ модели оборвался на пределе длины");
  }
  const lastSearch = lastSearchIndex(content);
  return {
    searchErrors: content.filter((part) => part.type === "tool-result" && part.toolName === "web_search" &&
      part.isError === true).length,
    searches: content.filter((part) =>
      part.type === "tool-call" && part.toolName === "web_search" && part.providerExecuted === true).length,
    text: content.slice(lastSearch + 1)
      .filter((part) => part.type === "text").map((part) => part.text).join("").trim(),
  };
}

export async function generateGuestText(
  model: LanguageModelV4,
  agentName: string,
  message: GuestMessage,
  notes: readonly GuestChatNote[],
): Promise<GuestText> {
  const result = await model.doGenerate({
    abortSignal: AbortSignal.timeout(GUEST_MODEL_TIMEOUT_MS),
    maxOutputTokens: GUEST_MAX_OUTPUT_TOKENS,
    prompt: [
      { content: guestSystemPrompt(agentName), role: "system" },
      { content: [{ text: guestUserPrompt(message, notes), type: "text" }], role: "user" },
    ],
    toolChoice: { type: "auto" },
    tools: [{ args: {}, id: "anthropic.web_search_20250305", name: "web_search", type: "provider" }],
  });
  return guestTextFromContent(result.content, result.finishReason);
}
