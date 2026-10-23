/**
 * Bounded Telegram transport for severe memory-review owner alerts.
 *
 * Exports:
 * - `MemoryReviewOwnerAlertTransportError`: definite Telegram delivery rejection.
 * - `createMemoryReviewOwnerAlertTransport`: injectable no-retry transport.
 * - `memoryReviewOwnerAlertTransport`: lazy production transport using the required bot token.
 *
 * `send` returns the confirmed Telegram message id: a message the bot started must land in the
 * proactive delivery journal, or the person's reply reaches a turn that never saw the question.
 */
import { callTelegramApi } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";

export class MemoryReviewOwnerAlertTransportError extends AppError {
  readonly delivery: "failed";

  constructor(delivery: "failed", code: string, message: string) {
    super(code, message);
    this.delivery = delivery;
    this.name = "MemoryReviewOwnerAlertTransportError";
  }
}

interface MemoryReviewOwnerAlertTransportDependencies {
  botToken: string;
  fetch: typeof fetch;
  timeoutMilliseconds: number;
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
    if (!response.ok) throw new MemoryReviewOwnerAlertTransportError(
      "failed",
      "AGENT_MEMORY_REVIEW_OWNER_ALERT_TELEGRAM_REJECTED",
      "Telegram отклонил уведомление владельца о сбое проверки памяти",
    );
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

function productionTransport(): MemoryReviewOwnerAlertTransport {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new AppError(
    "AGENT_TELEGRAM_CONFIG_MISSING",
    "Не задан токен Telegram для уведомления владельца",
  );
  return createMemoryReviewOwnerAlertTransport({
    botToken,
    fetch,
    timeoutMilliseconds: TELEGRAM_API_REQUEST_TIMEOUT_MS,
  });
}

// Runtime secrets stay lazy so Eve discovery and build remain deterministic.
export const memoryReviewOwnerAlertTransport: MemoryReviewOwnerAlertTransport = {
  deliver: (input) => productionTransport().deliver(input),
  send: (input) => productionTransport().send(input),
};
