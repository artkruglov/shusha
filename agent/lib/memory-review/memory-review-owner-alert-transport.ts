/**
 * Bounded Telegram transport for severe memory-review owner alerts.
 *
 * Exports:
 * - `MemoryReviewOwnerAlertTransportError`: definite Telegram delivery rejection.
 * - `TelegramRecipientUnreachableError`: the definite rejection of a chat that can no longer receive
 *   messages, or the skip of a chat already known to be so.
 * - `createMemoryReviewOwnerAlertTransport`: injectable no-retry transport.
 * - `memoryReviewOwnerAlertTransport`: lazy production transport for messages the bot starts itself
 *   (overviews, coach touches, digests, alerts); skips a chat marked unreachable without a request.
 * - `telegramReplyTransport`: the same transport for an answer to a person's own button or page
 *   action, which never skips: whoever pressed is reachable.
 *
 * `send` returns the confirmed Telegram message id: a message the bot started must land in the
 * proactive delivery journal, or the person's reply reaches a turn that never saw the question.
 * The unreachable error extends the definite rejection, so every dispatcher treats it as a refusal:
 * nothing was delivered. Dispatchers that release a refused claim for the next tick (the digest, the
 * balance alert) keep the day's claim for this one instead, or every tick would only skip again.
 */
import { callTelegramApi } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import {
  classifyTelegramRecipientFailure,
  TELEGRAM_RECIPIENT_UNREACHABLE_CODE,
  type TelegramRecipientUnreachableReason,
} from "../telegram-reachability/recipient-failure.js";
import { unreachableTelegramRecipient } from "../telegram-reachability/reachability-guard.js";

export class MemoryReviewOwnerAlertTransportError extends AppError {
  readonly delivery: "failed";

  constructor(delivery: "failed", code: string, message: string) {
    super(code, message);
    this.delivery = delivery;
    this.name = "MemoryReviewOwnerAlertTransportError";
  }
}

export class TelegramRecipientUnreachableError extends MemoryReviewOwnerAlertTransportError {
  readonly chatId: string;
  readonly reason: TelegramRecipientUnreachableReason;

  constructor(chatId: string, reason: TelegramRecipientUnreachableReason) {
    super(
      "failed",
      TELEGRAM_RECIPIENT_UNREACHABLE_CODE,
      "Telegram не доставляет сообщения в этот чат: бот заблокирован, удалён из группы или чат недоступен",
    );
    this.chatId = chatId;
    this.reason = reason;
    this.name = "TelegramRecipientUnreachableError";
  }
}

interface MemoryReviewOwnerAlertTransportDependencies {
  botToken: string;
  fetch: typeof fetch;
  timeoutMilliseconds: number;
  /** The reason a bot-started message must skip this chat; absent for answers to a person's action. */
  unreachableRecipient?: (chatId: string) => Promise<TelegramRecipientUnreachableReason | null>;
}

/** Formatting by offsets (Bot API `MessageEntity`): the text itself stays plain. */
export type TelegramTextEntity = { length: number; offset: number; type: "bold" | "strikethrough" };

export interface TelegramPlainMessage {
  chatId: string;
  entities?: readonly TelegramTextEntity[];
  /** Inline keyboard under the message (task buttons, migration 179). */
  replyMarkup?: {
    inline_keyboard: Array<Array<{ callback_data: string; text: string } | { text: string; web_app: { url: string } }>>;
  };
  text: string;
}

export interface MemoryReviewOwnerAlertTransport {
  deliver(input: TelegramPlainMessage): Promise<void>;
  send(input: TelegramPlainMessage): Promise<string>;
}

function confirmedMessageId(body: unknown): string | null {
  const result = (body as { result?: { message_id?: unknown } } | null)?.result;
  const id = result?.message_id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

export function createMemoryReviewOwnerAlertTransport(
  dependencies: MemoryReviewOwnerAlertTransportDependencies,
): MemoryReviewOwnerAlertTransport {
  if (!dependencies.botToken) throw new AppError(
    "AGENT_TELEGRAM_CONFIG_MISSING",
    "Не задан токен Telegram для уведомления владельца",
  );
  if (!Number.isSafeInteger(dependencies.timeoutMilliseconds) ||
      dependencies.timeoutMilliseconds <= 0) throw new AppError(
    "AGENT_MEMORY_REVIEW_OWNER_ALERT_TIMEOUT_INVALID",
    "Тайм-аут уведомления владельца должен быть положительным целым числом",
  );

  const boundedFetch: typeof fetch = (request, init) => dependencies.fetch(request, {
    ...init,
    signal: AbortSignal.timeout(dependencies.timeoutMilliseconds),
  });
  const post = async (input: TelegramPlainMessage): Promise<unknown> => {
    let known: TelegramRecipientUnreachableReason | null;
    try {
      known = await dependencies.unreachableRecipient?.(input.chatId) ?? null;
    } catch {
      // Nothing reached Telegram, so this is a definite failure: a dispatcher may try again.
      throw new MemoryReviewOwnerAlertTransportError(
        "failed",
        "AGENT_TELEGRAM_REACHABILITY_UNAVAILABLE",
        "Не удалось проверить, доступен ли чат; сообщение не отправлено",
      );
    }
    if (known !== null) throw new TelegramRecipientUnreachableError(input.chatId, known);
    const response = await callTelegramApi({
      body: {
        chat_id: input.chatId, text: input.text,
        ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
        ...(input.entities && input.entities.length > 0 ? { entities: input.entities.map((entity) => ({ ...entity })) } : {}),
      },
      botToken: dependencies.botToken,
      fetch: boundedFetch,
      method: "sendMessage",
    });
    if (!response.ok) {
      const reason = classifyTelegramRecipientFailure(response.status, response.body);
      if (reason !== null) throw new TelegramRecipientUnreachableError(input.chatId, reason);
      throw new MemoryReviewOwnerAlertTransportError(
        "failed",
        "AGENT_MEMORY_REVIEW_OWNER_ALERT_TELEGRAM_REJECTED",
        "Telegram отклонил уведомление владельца о сбое проверки памяти",
      );
    }
    return response.body;
  };
  return {
    async deliver(input): Promise<void> {
      await post(input);
    },
    async send(input): Promise<string> {
      const messageId = confirmedMessageId(await post(input));
      // Принятое без id сообщение ушло, но записать его нельзя: это не отказ, заявку не возвращать.
      if (messageId === null) throw new AppError(
        "AGENT_TELEGRAM_MESSAGE_ID_MISSING",
        "Telegram принял сообщение, но не подтвердил его идентификатор",
      );
      return messageId;
    },
  };
}

function productionTransport(proactive: boolean): MemoryReviewOwnerAlertTransport {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new AppError(
    "AGENT_TELEGRAM_CONFIG_MISSING",
    "Не задан токен Telegram для уведомления владельца",
  );
  return createMemoryReviewOwnerAlertTransport({
    botToken,
    fetch,
    timeoutMilliseconds: TELEGRAM_API_REQUEST_TIMEOUT_MS,
    ...(proactive
      ? { unreachableRecipient: (chatId: string) => unreachableTelegramRecipient(chatId, "proactive_message") }
      : {}),
  });
}

// Runtime secrets stay lazy so Eve discovery and build remain deterministic.
export const memoryReviewOwnerAlertTransport: MemoryReviewOwnerAlertTransport = {
  deliver: (input) => productionTransport(true).deliver(input),
  send: (input) => productionTransport(true).send(input),
};

export const telegramReplyTransport: MemoryReviewOwnerAlertTransport = {
  deliver: (input) => productionTransport(false).deliver(input),
  send: (input) => productionTransport(false).send(input),
};
