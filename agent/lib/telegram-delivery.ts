/**
 * Trusted Telegram delivery adapter.
 *
 * Exports:
 * - `deliverFamilyInvitation`: sends a one-time invitation without model exposure.
 * - `notifyWaitlistPerson`: tells someone from the signup queue that a place has opened.
 * - `notifyOwnerMemberJoined`: tells the owner, outside the model, that someone joined by their link.
 *
 * The three notices are started by the bot, so each skips a chat Telegram already calls unreachable; the
 * invitation answers the owner's own request in their chat and never does.
 */
import { sendTelegramMessage } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../config.js";
import {
  type TelegramProactiveDeliveryKind,
  unreachableTelegramRecipient,
} from "./telegram-reachability/reachability-guard.js";

interface FamilyInvitationDelivery {
  chatId: string;
  code: string;
  expiresAt: string;
  signal: AbortSignal;
}

function requireTelegramDeliveryConfig(): { botToken: string; botUsername: string } {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const botUsername = process.env.TELEGRAM_BOT_USERNAME;
  if (!botToken || !botUsername) {
    throw new Error(
      "AGENT_TELEGRAM_CONFIG_MISSING: Не заданы настройки Telegram для доставки приглашения",
    );
  }
  return { botToken, botUsername };
}

export async function deliverFamilyInvitation(input: FamilyInvitationDelivery): Promise<void> {
  const { botToken, botUsername } = requireTelegramDeliveryConfig();
  const startLink = `https://t.me/${botUsername}?start=${encodeURIComponent(input.code)}`;

  // The token is sent directly to the verified owner chat and is never returned as tool output.
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS),
  ]);
  const fetchWithSignal: typeof fetch = (request, init) =>
    fetch(request, {
      ...init,
      signal,
    });

  // Eve owns Telegram request construction while this adapter owns cancellation and secret handling.
  try {
    await sendTelegramMessage({
      body: {
        text: [
          "Одноразовое приглашение в семейного агента:",
          startLink,
          `Действует до ${input.expiresAt}.`,
        ].join("\n"),
      },
      chatId: input.chatId,
      credentials: { botToken },
      fetch: fetchWithSignal,
    });
  } catch (error) {
    // Preserve the original transport error while adding safe structured diagnostics and a stable code.
    console.error(
      JSON.stringify({
        code: "AGENT_TELEGRAM_INVITATION_DELIVERY_FAILED",
        errorName: error instanceof Error ? error.name : "UnknownError",
        providerMessage: error instanceof Error ? error.message : String(error),
      }),
    );
    if (error instanceof Error) {
      error.message =
        "AGENT_TELEGRAM_INVITATION_DELIVERY_FAILED: Не удалось связаться с Telegram. Попробуйте еще раз";
    }
    throw error;
  }
}

async function reachable(chatId: string, kind: TelegramProactiveDeliveryKind): Promise<boolean> {
  return await unreachableTelegramRecipient(chatId, kind) === null;
}

/** Сбой уведомления не отменяет вход: человек уже в семье, владелец узнает из списка участников. */
export async function notifyOwnerMemberJoined(input: {
  memberName: string;
  ownerTelegramUserId: string;
  /** Как человек вошёл: по вашей ссылке или сам, написав в подключённой группе. */
  via?: "group" | "link";
}): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  try {
    if (!await reachable(input.ownerTelegramUserId, "member_joined_notice")) return;
    await sendTelegramMessage({
      body: {
        text: `${input.via === "group" ? "Новый участник вошёл в семью через вашу группу" : "По вашей ссылке в семью добавлен"}: ${input.memberName}. Если это не тот человек, напишите мне «убери ${input.memberName}».`,
      },
      chatId: input.ownerTelegramUserId,
      credentials: { botToken },
      fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS) }),
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_OWNER_JOIN_NOTICE_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
  }
}

/** Оператору: новый человек просится в закрытую Юну. Сбой доставки не мешает ответу самому человеку. */
export async function notifyOperatorWaitlist(input: { name: string; username?: string; operatorTelegramUserId: string }): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  const who = input.username ? `${input.name} (@${input.username})` : input.name;
  try {
    if (!await reachable(input.operatorTelegramUserId, "waitlist_notice")) return;
    await sendTelegramMessage({
      body: { text: `Новая заявка: ${who} ждёт приглашения. Пустить первых из очереди: /signup open <число мест> [слово].` },
      chatId: input.operatorTelegramUserId,
      credentials: { botToken },
      fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS) }),
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_SIGNUP_OPERATOR_NOTICE_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
  }
}

/** Сбой одному человеку из очереди не должен останавливать остальных. */
export async function notifyWaitlistPerson(telegramUserId: string, word: string | null): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return false;
  // С заданным словом простой /start отказал бы: ссылка обязана нести то же слово, по которому выделялось место.
  const bot = process.env.TELEGRAM_BOT_USERNAME;
  const how = word !== null && bot ? `Откройте ссылку https://t.me/${bot}?start=${word} и я подключу вашу семью.` : "Напишите мне /start, и я подключу вашу семью.";
  try {
    if (!await reachable(telegramUserId, "waitlist_notice")) return false;
    await sendTelegramMessage({
      body: { text: `Появились места. ${how}` },
      chatId: telegramUserId,
      credentials: { botToken },
      fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS) }),
    });
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_SIGNUP_WAITLIST_NOTICE_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    return false;
  }
}
