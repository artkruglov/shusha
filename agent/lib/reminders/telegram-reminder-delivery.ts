/**
 * Trusted proactive Telegram reminder delivery.
 *
 * Exports:
 * - `deliverTelegramReminder`: sends deterministic text and returns its durable delivery receipt.
 * - `deliverReachableTelegramReminder`: the same after the reachability check of the target chat.
 *
 * A chat Telegram calls gone (blocked bot, deleted account, bot removed from the group) fails the reminder
 * with `AGENT_TELEGRAM_RECIPIENT_UNREACHABLE`, and a chat already marked so is skipped without a request:
 * the reminder fails with the same code instead of writing into the chat again.
 */
import { callTelegramApi } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import { TelegramRecipientUnreachableError } from "../memory-review/memory-review-owner-alert-transport.js";
import { classifyTelegramRecipientFailure } from "../telegram-reachability/recipient-failure.js";
import { unreachableTelegramRecipient } from "../telegram-reachability/reachability-guard.js";
import type { ProactiveDeliveryReceipt } from "../proactive-deliveries/proactive-delivery-repository.js";
import type { ClaimedReminder } from "./reminder-dispatch-repository.js";

function requireBotToken(): string {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error(
      "AGENT_TELEGRAM_CONFIG_MISSING: Не задан токен Telegram для доставки напоминаний",
    );
  }
  return botToken;
}

function messageThreadId(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      "AGENT_REMINDER_THREAD_INVALID: Сохранён некорректный идентификатор темы Telegram",
    );
  }
  return parsed;
}

function formatScheduledTime(job: ClaimedReminder): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: job.timezone,
  }).format(new Date(job.dueAt));
}

export async function deliverTelegramReminder(job: ClaimedReminder): Promise<ProactiveDeliveryReceipt> {
  const delayedNotice = job.delayed
    ? `Доставлено с задержкой. Изначальное время: ${formatScheduledTime(job)} (${job.timezone}).`
    : null;
  const heading = job.taskReminderKind === 'response' ? 'Проверить ответ на вашу просьбу:' : 'Напоминание:';
  const text = [heading, job.content, delayedNotice].filter(Boolean).join("\n\n");
  const signal = AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS);
  const fetchWithTimeout: typeof fetch = (request, init) => fetch(request, { ...init, signal });

  // Telegram has no idempotency key; the durable marker is written before this boundary call.
  try {
    const threadId = job.messageThreadId === null ? undefined : messageThreadId(job.messageThreadId);
    const response = await callTelegramApi({
      body: {
        chat_id: job.telegramChatId,
        ...(threadId === undefined ? {} : { message_thread_id: threadId }),
        text,
      },
      botToken: requireBotToken(),
      fetch: fetchWithTimeout,
      method: "sendMessage",
    });
    if (!response.ok) {
      const reason = classifyTelegramRecipientFailure(response.status, response.body);
      if (reason !== null) throw new TelegramRecipientUnreachableError(job.telegramChatId, reason);
      throw new Error(`Telegram sendMessage failed with HTTP ${response.status}.`);
    }
    const sentId = (response.body as { result?: { message_id?: unknown } } | null)?.result?.message_id;
    const messageId = typeof sentId === "number" || typeof sentId === "string" ? String(sentId) : "";
    if (!/^[1-9]\d*$/u.test(messageId)) {
      throw new AppError(
        "AGENT_REMINDER_TELEGRAM_DELIVERY_AMBIGUOUS",
        "Telegram принял напоминание, но не подтвердил идентификатор сообщения",
      );
    }
    return { messageId, text };
  } catch (error) {
    console.error(JSON.stringify({
      code: error instanceof TelegramRecipientUnreachableError
        ? error.code
        : "AGENT_REMINDER_TELEGRAM_DELIVERY_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
      reminderId: job.id,
    }));
    throw error;
  }
}

export async function deliverReachableTelegramReminder(job: ClaimedReminder): Promise<ProactiveDeliveryReceipt> {
  const reason = await unreachableTelegramRecipient(job.telegramChatId, "reminder");
  if (reason !== null) throw new TelegramRecipientUnreachableError(job.telegramChatId, reason);
  return deliverTelegramReminder(job);
}
