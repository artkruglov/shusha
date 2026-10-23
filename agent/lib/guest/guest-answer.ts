/**
 * One answer to a guest message (Bot API 10.0), outside any Eve session.
 *
 * Exports:
 * - `createGuestAnswerer`: caller ceiling, one model call, one `answerGuestQuery`; dependencies injected.
 * - `answerTelegramGuestMessage`: the production answerer used by the durable ingress.
 *
 * Every answer carries a button into the private chat: guest mode is the door, the private chat is
 * where personal reminders and memory live. A bot caller gets no answer, so two bots cannot loop.
 * A failed generation still answers with a short failure text and returns the caller's quota slot.
 * The chat's own notes (migration 174) are read before the model call and the answer's directives
 * are applied before anything is sent; a reminder offer adds a «Напомнить и мне» button whose press
 * `guest-reminder-callback.ts` turns into a personal reminder for a family member.
 */
import { callTelegramApi } from "eve/channels/telegram";

import { AppError } from "../app-error.js";
import { errandResearchModel } from "../model-registry.js";
import { readTelegramAgentIdentity } from "../telegram-agent-identity.js";
import { guestChatRepository, type GuestAppliedActions, type GuestChatNote } from "./guest-chat-repository.js";
import { parseGuestDirectives, type GuestAction } from "./guest-directives.js";
import { generateGuestText, type GuestText } from "./guest-model.js";
import { GUEST_REMINDER_CALLBACK_PREFIX } from "./guest-reminder-callback-data.js";
import { guestQuotaRepository, type GuestQuotaDecision, type GuestQuotaLimits } from "./guest-quota-repository.js";
import { GUEST_START_PAYLOAD, parseGuestMessage, type GuestMessage } from "./guest-message.js";

/** Telegram text limit is 4096; the tail is cut on a word with an ellipsis. */
const GUEST_ANSWER_MAX_CHARACTERS = 4_000;
const GUEST_TELEGRAM_TIMEOUT_MS = 15_000;
export const GUEST_QUOTA_LIMITS: GuestQuotaLimits = { perCallerPerDay: 20, perDay: 1_000 };

const LIMIT_TEXT: Record<Exclude<GuestQuotaDecision, "allowed">, string> = {
  caller_limit: "На сегодня гостевые ответы для вас закончились. В личном чате со мной ограничений меньше, кнопка ниже.",
  daily_limit: "Сегодня я уже ответила гостем слишком многим. Напишите мне в личный чат, кнопка ниже.",
};

const FAILURE_TEXT = "Не получилось ответить: что-то сломалось у меня. Попробуйте позвать меня ещё раз чуть позже.";

const DONE_TEXT = "Готово.";

/** The model said it saved something, but a directive was malformed or pointed past the list. */
const PARTLY_SAVED_TEXT = "Часть просьбы я не смогла записать, повторите её, пожалуйста.";

export interface GuestAnswerInput {
  readonly buttonText: string;
  readonly buttonUrl: string;
  readonly queryId: string;
  /** Present when the answer offers «Напомнить и мне». */
  readonly reminderOfferId: string | null;
  readonly text: string;
}

export interface GuestAnswerDependencies {
  readonly agentName: string;
  readonly botUsername: string;
  answer(input: GuestAnswerInput): Promise<void>;
  applyActions(input: {
    actions: readonly GuestAction[];
    authorTelegramUserId: string;
    chatKey: string;
    shown: readonly GuestChatNote[];
  }): Promise<GuestAppliedActions>;
  claimQuota(callerId: string): Promise<GuestQuotaDecision>;
  generate(agentName: string, message: GuestMessage, notes: readonly GuestChatNote[]): Promise<GuestText>;
  /** Marks the chat as summoned and returns its notes as the prompt numbers them. */
  summon(chatKey: string): Promise<GuestChatNote[]>;
  /** Returns the slot of an answer that failed before anything was sent. */
  releaseQuota(callerId: string): Promise<void>;
}

/** Cuts on code points: a lone half of a surrogate pair makes Telegram reject the whole answer. */
export function clipCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

function clip(text: string): string {
  if (Array.from(text).length <= GUEST_ANSWER_MAX_CHARACTERS) return text;
  const cut = clipCodePoints(text, GUEST_ANSWER_MAX_CHARACTERS - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > cut.length / 2 ? cut.slice(0, space) : cut}…`;
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : error instanceof Error ? error.name : "unknown";
}

export function createGuestAnswerer(dependencies: GuestAnswerDependencies) {
  return async function answerGuestMessage(raw: Record<string, unknown>, updateId: string): Promise<void> {
    const startedAt = Date.now();
    const message = parseGuestMessage(raw, dependencies.botUsername);
    if (message.callerIsBot) {
      console.info(JSON.stringify({ code: "AGENT_GUEST_BOT_CALLER_SKIPPED", updateId }));
      return;
    }
    let decision: GuestQuotaDecision | "introduction" = "introduction";
    let text: string;
    let searches = 0;
    let searchErrors = 0;
    let reminderOfferId: string | null = null;
    let directives = { actions: 0, dropped: 0, skipped: 0 };
    if (!message.question && !message.quoted) {
      // A bare mention costs no model call, so it does not spend the caller's daily answers.
      text = `Я ${dependencies.agentName}. Напишите вопрос вместе с упоминанием, и я отвечу прямо здесь. Напоминания и дела живут в личном чате со мной.`;
    } else {
      decision = await dependencies.claimQuota(message.callerId);
      if (decision !== "allowed") {
        text = LIMIT_TEXT[decision];
      } else {
        try {
          const notes = await dependencies.summon(message.chatKey);
          const generated = await dependencies.generate(dependencies.agentName, message, notes);
          searches = generated.searches;
          searchErrors = generated.searchErrors;
          const parsed = parseGuestDirectives(generated.text, new Date());
          if (!parsed.text && parsed.actions.length === 0) {
            throw new AppError("AGENT_GUEST_ANSWER_EMPTY", "Модель не дала текста для гостевого ответа");
          }
          const applied = await dependencies.applyActions({
            actions: parsed.actions,
            authorTelegramUserId: message.callerId,
            chatKey: message.chatKey,
            shown: notes,
          });
          reminderOfferId = applied.offerId;
          directives = { actions: parsed.actions.length, dropped: parsed.dropped, skipped: applied.skipped };
          text = parsed.text || DONE_TEXT;
          if (parsed.dropped + applied.skipped > 0) text = `${text}\n\n${PARTLY_SAVED_TEXT}`;
        } catch (error) {
          // The guest query is answered at most once and nothing was sent yet: silence would look like
          // the bot ignored the person, so they get a short failure and keep their daily answer.
          console.error(JSON.stringify({ code: "AGENT_GUEST_ANSWER_FAILED", errorCode: errorCode(error), updateId }));
          await dependencies.releaseQuota(message.callerId);
          text = FAILURE_TEXT;
        }
      }
    }
    const answer: GuestAnswerInput = {
      buttonText: `Открыть ${dependencies.agentName}`,
      buttonUrl: `https://t.me/${dependencies.botUsername}?start=${GUEST_START_PAYLOAD}`,
      queryId: message.queryId,
      reminderOfferId,
      text: clip(text),
    };
    try {
      await dependencies.answer(answer);
    } catch (error) {
      // A rejected answer leaves the query open. The reminder button is the only part not yet seen
      // live in a guest answer, so the text goes out once more without it rather than not at all.
      if (!reminderOfferId || !(error instanceof AppError) || error.code !== "AGENT_GUEST_ANSWER_REJECTED") throw error;
      console.error(JSON.stringify({ code: "AGENT_GUEST_REMINDER_BUTTON_REJECTED", error: error.message, updateId }));
      reminderOfferId = null;
      await dependencies.answer({ ...answer, reminderOfferId: null });
    }
    console.info(JSON.stringify({
      characters: text.length,
      code: "AGENT_GUEST_ANSWERED",
      decision,
      directives,
      ms: Date.now() - startedAt,
      reminderOffered: reminderOfferId !== null,
      quoted: message.quoted !== null,
      searchErrors,
      searches,
      updateId,
    }));
  };
}

function telegramDescription(body: unknown): string {
  if (body && typeof body === "object" && "description" in body && typeof body.description === "string") {
    return `: ${body.description}`;
  }
  return "";
}

async function answerGuestQuery(input: GuestAnswerInput) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new AppError("AGENT_TELEGRAM_BOT_TOKEN_MISSING", "Не задан TELEGRAM_BOT_TOKEN для гостевого ответа");
  }
  const response = await callTelegramApi({
    body: {
      guest_query_id: input.queryId,
      result: {
        id: input.queryId.slice(0, 64),
        input_message_content: { link_preview_options: { is_disabled: true }, message_text: input.text },
        reply_markup: {
          inline_keyboard: [
            ...(input.reminderOfferId
              ? [[{ callback_data: `${GUEST_REMINDER_CALLBACK_PREFIX}${input.reminderOfferId}`, text: "🔔 Напомнить и мне" }]]
              : []),
            [{ text: input.buttonText, url: input.buttonUrl }],
          ],
        },
        title: clipCodePoints(input.text, 64),
        type: "article",
      },
    },
    botToken,
    fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(GUEST_TELEGRAM_TIMEOUT_MS) }),
    method: "answerGuestQuery",
  });
  if (!response.ok) {
    throw new AppError(
      "AGENT_GUEST_ANSWER_REJECTED",
      `Telegram отклонил гостевой ответ (HTTP ${response.status})${telegramDescription(response.body)}`,
    );
  }
}

let productionAnswerer: ReturnType<typeof createGuestAnswerer> | undefined;

function requireBotUsername(): string {
  const username = process.env.TELEGRAM_BOT_USERNAME?.trim();
  if (!username) {
    throw new AppError("AGENT_TELEGRAM_BOT_USERNAME_MISSING", "Не задан TELEGRAM_BOT_USERNAME для гостевого ответа");
  }
  return username;
}

export function answerTelegramGuestMessage(raw: Record<string, unknown>, updateId: string): Promise<void> {
  productionAnswerer ??= createGuestAnswerer({
    agentName: readTelegramAgentIdentity().name,
    answer: answerGuestQuery,
    applyActions: (input) => guestChatRepository.apply(input),
    botUsername: requireBotUsername(),
    claimQuota: (callerId) => guestQuotaRepository.claim(callerId, GUEST_QUOTA_LIMITS),
    generate: (agentName, message, notes) => generateGuestText(errandResearchModel, agentName, message, notes),
    releaseQuota: (callerId) => guestQuotaRepository.release(callerId),
    summon: (chatKey) => guestChatRepository.summon(chatKey),
  });
  return productionAnswerer(raw, updateId);
}
