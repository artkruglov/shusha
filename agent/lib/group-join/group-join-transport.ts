/**
 * Telegram для заявок в группы («Группы», шаг 2): несколько методов Bot API без повторов.
 *
 * Exports:
 * - `GroupJoinTransport`: что нужно заявкам и подготовке группы; в тестах подменяется.
 * - `groupJoinTransport`: тот же набор через транспорт Eve и `TELEGRAM_BOT_TOKEN`.
 * - `telegramBotId`: id самого бота из токена, по нему узнаётся ссылка, которую выпустил бот.
 *
 * Каждый вызов ждёт не дольше `TIMEOUT_MS` и не повторяется: заявку и сообщение Telegram держит сам, а повтор
 * после неоднозначного сбоя удвоил бы сообщение человеку.
 */
import { callTelegramApi } from "eve/channels/telegram";

import { AppError } from "../app-error.js";

const TIMEOUT_MS = 15_000;

export type InlineKeyboard = ReadonlyArray<ReadonlyArray<{ callback_data: string; text: string }>>;

export interface GroupJoinTransport {
  /** Пустить человека по заявке; false, если заявки уже нет (отозвана, решена, человек уже в группе). */
  approve(chatId: string, userId: string): Promise<boolean>;
  decline(chatId: string, userId: string): Promise<boolean>;
  /** Права бота в группе: `invite` выпускать ссылки и решать заявки, `pin` закреплять. */
  botRights(chatId: string): Promise<{ invite: boolean; pin: boolean }>;
  /** Новая ссылка с заявками на вступление. */
  createInviteLink(chatId: string, name: string): Promise<string>;
  edit(chatId: string, messageId: string, text: string, keyboard?: InlineKeyboard): Promise<void>;
  pin(chatId: string, messageId: string): Promise<void>;
  /** Возвращает id отправленного сообщения. */
  send(chatId: string, text: string, keyboard?: InlineKeyboard): Promise<string>;
}

function botToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new AppError("AGENT_TELEGRAM_BOT_TOKEN_MISSING", "Не задан TELEGRAM_BOT_TOKEN для заявок в группы");
  return token;
}

export function telegramBotId(token: string = botToken()): string {
  const id = /^([1-9]\d*):/u.exec(token)?.[1];
  if (!id) throw new AppError("AGENT_TELEGRAM_BOT_TOKEN_INVALID", "TELEGRAM_BOT_TOKEN не похож на токен бота");
  return id;
}

type Reply = { ok: boolean; description: string; result: unknown };

async function call(method: string, body: Record<string, unknown>): Promise<Reply> {
  const response = await callTelegramApi({
    body: body as never,
    botToken: botToken(),
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }),
    method,
  });
  const payload = (response.body ?? {}) as { description?: unknown; ok?: unknown; result?: unknown };
  return {
    description: typeof payload.description === "string" ? payload.description : "",
    ok: response.ok && payload.ok === true,
    result: payload.result,
  };
}

function failed(method: string, reply: Reply): AppError {
  return new AppError("AGENT_GROUP_JOIN_TELEGRAM_FAILED", `Telegram не выполнил ${method}: ${reply.description || "без ответа"}`);
}

async function required(method: string, body: Record<string, unknown>): Promise<unknown> {
  const reply = await call(method, body);
  if (!reply.ok) throw failed(method, reply);
  return reply.result;
}

/** Заявки уже нет: Telegram отвечает так на повторное или опоздавшее решение. */
const GONE = /HIDE_REQUESTER_MISSING|USER_ALREADY_PARTICIPANT|request not found/iu;

async function decide(method: "approveChatJoinRequest" | "declineChatJoinRequest", chatId: string, userId: string) {
  const reply = await call(method, { chat_id: chatId, user_id: Number(userId) });
  if (reply.ok) return true;
  if (GONE.test(reply.description)) return false;
  throw failed(method, reply);
}

const keyboardMarkup = (keyboard?: InlineKeyboard) => ({ reply_markup: { inline_keyboard: keyboard ?? [] } });

export const groupJoinTransport: GroupJoinTransport = {
  approve: (chatId, userId) => decide("approveChatJoinRequest", chatId, userId),
  decline: (chatId, userId) => decide("declineChatJoinRequest", chatId, userId),
  async botRights(chatId) {
    const reply = await call("getChatMember", { chat_id: chatId, user_id: Number(telegramBotId()) });
    const member = (reply.ok ? reply.result : {}) as { can_invite_users?: unknown; can_pin_messages?: unknown; status?: unknown };
    const admin = member.status === "administrator";
    return { invite: admin && member.can_invite_users === true, pin: admin && member.can_pin_messages === true };
  },
  async createInviteLink(chatId, name) {
    const result = await required("createChatInviteLink", { chat_id: chatId, creates_join_request: true, name }) as { invite_link?: unknown };
    if (typeof result?.invite_link !== "string") {
      throw new AppError("AGENT_GROUP_JOIN_TELEGRAM_FAILED", "Telegram не вернул ссылку-приглашение");
    }
    return result.invite_link;
  },
  async edit(chatId, messageId, text, keyboard) {
    await required("editMessageText", { chat_id: chatId, message_id: Number(messageId), text, ...keyboardMarkup(keyboard) });
  },
  async pin(chatId, messageId) {
    await required("pinChatMessage", { chat_id: chatId, disable_notification: true, message_id: Number(messageId) });
  },
  async send(chatId, text, keyboard) {
    const result = await required("sendMessage", {
      chat_id: chatId, link_preview_options: { is_disabled: true }, text, ...(keyboard ? keyboardMarkup(keyboard) : {}),
    }) as { message_id?: unknown };
    if (typeof result?.message_id !== "number") {
      throw new AppError("AGENT_GROUP_JOIN_TELEGRAM_FAILED", "Telegram не вернул номер сообщения");
    }
    return String(result.message_id);
  },
};
