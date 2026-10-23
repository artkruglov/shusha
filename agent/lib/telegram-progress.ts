/**
 * Telegram delivery policy for completed model messages.
 *
 * Exports:
 * - `CompletedTelegramOutput`: final message, silent reaction, or interim progress decision.
 * - `completedTelegramOutput`: validates model output before Telegram delivery.
 * - `silentGroupTurnRecord`: log record for a group turn that ended in deliberate silence.
 *
 * Provider adapters route typed reasoning parts to dedicated Eve events that this delivery
 * policy never receives.
 */
import { AppError } from "./app-error.js";
import { extractMemoryUsedDirective } from "./memory-used-directive.js";
import { stripTelegramAsideDirectives } from "./telegram-authored-split.js";
import {
  isTelegramMessageReactionEmoji,
  nearestTelegramReactionEmoji,
  type TelegramMessageReactionEmoji,
} from "./telegram-message-reaction.js";

const TOOL_CALLS_FINISH_REASON = "tool-calls";
const TELEGRAM_REACTION_DIRECTIVE_PATTERN =
  /^<telegram-reaction>(?<emoji>[^<]*)<\/telegram-reaction>$/u;
const TELEGRAM_REACTION_DIRECTIVE_FRAGMENT = "telegram-reaction";
// A whole answer that is one tag pair around something short. With tag names that resemble the
// reaction directive it is the gesture the model meant: on 16 October 2026 a group chat read
// `<telegereaction>😁</telegereaction>` as text because the misspelling carried neither the
// directive nor its fragment. With other names and nothing inside it is a directive nobody
// defined, never a message.
const LONE_TAG_PAIR_PATTERN = /^<(?<open>[a-z][a-z-]*)>(?<inner>[^<>]*)<\/(?<close>[a-z][a-z-]*)>$/u;

function resemblesReactionTag(name: string): boolean {
  return name.includes("react") || name.includes("teleg");
}

function loneTagPair(message: string): { close: string; inner: string; open: string } | null {
  const groups = LONE_TAG_PAIR_PATTERN.exec(message)?.groups;
  return groups === undefined ? null : { close: groups.close!, inner: groups.inner!, open: groups.open! };
}

function misspelledReactionDirective(message: string): { close: string; emoji: string; open: string } | null {
  const pair = loneTagPair(message);
  if (pair === null || !resemblesReactionTag(pair.open) || !resemblesReactionTag(pair.close)) return null;
  // The exact directive is not a misspelling; its own path decides. Words inside a tag that merely
  // resembles the directive stay text: only an emoji is the gesture the model meant.
  if (pair.open === TELEGRAM_REACTION_DIRECTIVE_FRAGMENT && pair.close === TELEGRAM_REACTION_DIRECTIVE_FRAGMENT) return null;
  if (!isTelegramMessageReactionEmoji(pair.inner)) return null;
  return { close: pair.close, emoji: pair.inner, open: pair.open };
}

/** A lone pair of tags around nothing is a directive nobody defined, never something to send. */
function emptyTagPair(message: string): boolean {
  const pair = loneTagPair(message);
  if (pair === null || pair.inner.trim() !== "") return false;
  console.warn(JSON.stringify({ code: "AGENT_TELEGRAM_OUTPUT_TAG_ONLY", close: pair.close, open: pair.open }));
  return true;
}

function reactionOutput(requested: string): CompletedTelegramOutput {
  // Telegram refuses reactions outside its set with 400, and a refused reaction left the person
  // with nothing (9 сентября 2026). The gesture arrives as the closest reaction Telegram takes.
  const emoji = nearestTelegramReactionEmoji(requested);
  if (emoji !== requested.replace(/\uFE0F/gu, "")) {
    console.warn(JSON.stringify({ code: "AGENT_TELEGRAM_REACTION_SUBSTITUTED", applied: emoji, requested }));
  }
  return { emoji, kind: "reaction" };
}
/**
 * The model's explicit way to say nothing. A genuinely empty answer is not available to it: Eve
 * retries an empty model step once, and the retry came back as a placeholder such as "(пусто)"
 * that went to the chat as a message. The directive is transport syntax and never reaches anyone.
 */
export const TELEGRAM_SILENT_DIRECTIVE = "<telegram-silent>";

// DeepSeek's native tool-call markup (`<｜DSML｜calls>` … `</｜DSML｜calls>`). A model that writes
// a call as text instead of a function call must not reach the chat with it: the span from the
// first to the last such tag is dropped and logged, the words around it stay.
const TOOL_MARKUP_TAG_PATTERN = /<\/?[｜|]+\s*DSML\s*[｜|]+[^>]*>/gu;

function stripLeakedToolMarkup(text: string): string {
  const tags = [...text.matchAll(TOOL_MARKUP_TAG_PATTERN)];
  if (tags.length === 0) return text;
  const first = tags[0]!.index;
  const last = tags.at(-1)!;
  const stripped = `${text.slice(0, first)}${text.slice(last.index + last[0].length)}`.replace(/\n{3,}/gu, "\n\n").trim();
  console.warn(JSON.stringify({ code: "AGENT_MODEL_TOOL_MARKUP_LEAKED", removedChars: text.length - stripped.length, tags: tags.length }));
  return stripped;
}

export type CompletedTelegramOutput =
  | { emoji: TelegramMessageReactionEmoji; kind: "reaction" }
  | { kind: "message"; memoryUsedDeclared: boolean; memoryUsedRefs: string[]; message: string }
  | { kind: "progress"; message: string };

/**
 * Групповой ход, закончившийся без текста, — это решение модели промолчать. Запись с причиной
 * хода показывает, сколько ходов семейная группа в режиме `all` тратит впустую.
 */
export function silentGroupTurnRecord(
  data: { finishReason: string },
  attributes: Readonly<Record<string, unknown>> | undefined,
): { code: "AGENT_TELEGRAM_SILENT_TURN"; trigger: string } | null {
  const trigger = attributes?.telegramGroupTurnTrigger;
  if (data.finishReason !== "stop" || typeof trigger !== "string") return null;
  return { code: "AGENT_TELEGRAM_SILENT_TURN", trigger };
}

/**
 * The final answer was the silence directive and nothing visible: the model chose to say nothing.
 * A scheduled run that ends so is complete, not a failed delivery.
 */
export function isDeliberateSilence(data: { finishReason: string; message?: string | null }): boolean {
  return data.finishReason === "stop" &&
    (data.message ?? "").includes(TELEGRAM_SILENT_DIRECTIVE) &&
    completedTelegramOutput(data) === null;
}

export function completedTelegramOutput(data: {
  finishReason: string;
  message?: string | null;
}): CompletedTelegramOutput | null {
  // Only completed visible assistant text should become a durable Telegram message.
  const raw = stripLeakedToolMarkup(
    data.message === undefined || data.message === null ? "" : data.message.trim(),
  );
  // The memory-used directive is bookkeeping for the final answer; it never reaches Telegram.
  const { declared: memoryUsedDeclared, memoryRefs: memoryUsedRefs, message: spoken } = extractMemoryUsedDirective(raw);
  // Silence wins only when it is all the model said; text next to the directive is the answer.
  const message = spoken.split(TELEGRAM_SILENT_DIRECTIVE).join("").trim();
  if (!message) {
    // The directive instead of an answer means the person gets nothing; count it, silence is deliberate.
    if (memoryUsedDeclared && !raw.includes(TELEGRAM_SILENT_DIRECTIVE)) console.warn(JSON.stringify({ code: "AGENT_MEMORY_USED_DIRECTIVE_ONLY" }));
    return null;
  }

  // Text authored before a tool call is what a person reads while a long task runs.
  if (data.finishReason === TOOL_CALLS_FINISH_REASON) {
    const progress = stripTelegramAsideDirectives(message).trim();
    // Transport directives belong to the final answer; interim noise is dropped, never delivered.
    if (!progress || progress.includes(TELEGRAM_REACTION_DIRECTIVE_FRAGMENT) || misspelledReactionDirective(progress) !== null) return null;
    if (emptyTagPair(progress)) return null;
    return { kind: "progress", message: progress };
  }

  // Reaction is a terminal transport directive and can never be mixed with user-visible text.
  const reaction = TELEGRAM_REACTION_DIRECTIVE_PATTERN.exec(message)?.groups?.emoji;
  if (reaction !== undefined && isTelegramMessageReactionEmoji(reaction)) return reactionOutput(reaction);
  const misspelled = misspelledReactionDirective(message);
  if (misspelled !== null) {
    console.warn(JSON.stringify({ code: "AGENT_TELEGRAM_REACTION_DIRECTIVE_REPAIRED", close: misspelled.close, open: misspelled.open }));
    return reactionOutput(misspelled.emoji);
  }
  if (message.includes(TELEGRAM_REACTION_DIRECTIVE_FRAGMENT)) {
    throw new AppError(
      "AGENT_TELEGRAM_REACTION_DIRECTIVE_INVALID",
      "Не удалось выбрать безопасную реакцию на сообщение",
    );
  }
  // An answer made of transport directives alone has no visible content to deliver.
  if (!stripTelegramAsideDirectives(message) || emptyTagPair(message)) return null;
  return { kind: "message", memoryUsedDeclared, memoryUsedRefs, message };
}
