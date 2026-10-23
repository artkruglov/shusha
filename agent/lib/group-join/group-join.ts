/**
 * Заявки в обычную группу семьи («Группы», шаг 2): Шуша встречает каждого в личке и пускает только своих.
 *
 * Exports:
 * - `GROUP_JOIN_CALLBACK_PREFIX`, `parseGroupJoinCallback`: кнопки заявок, `gj:<j|n>:<чат>` у просящегося и
 *   `gj:<a|r>:<чат>:<человек>` у владельца.
 * - `parseChatJoinRequest`: проверенный `chat_join_request` из сырого update или null.
 * - `createGroupJoin`: обработчики заявки и кнопок, зависимости подаются снаружи.
 * - `handleChatJoinRequest`, `handleGroupJoinCallback`: то же на базе приложения.
 *
 * Как это устроено:
 * - Заявка приходит только по ссылке, которую выпустил сам бот (`invite_link.creator`): заявки по ссылкам
 *   администраторов решают они сами. Ботам и группам не нашей семьи бот не пишет.
 * - Bot API даёт пять минут написать просящемуся в личку, даже если тот не писал боту: сообщение уходит сразу,
 *   с кнопками «Вступить» и «Не сейчас».
 * - «Вступить» участника семьи сразу пускает в группу. Остальных бот не пускает сам: владелец семьи получает
 *   вопрос «Пустить?», и только его нажатие, проверенное по базе в момент нажатия, одобряет заявку.
 * - Заявку держит Telegram, а строка `group_join_invitations` (миграция 188) доказывает, что бот встретил именно
 *   этого человека про эту группу, и делает решение однократным: нажатие сначала забирает строку, потом идёт в
 *   Telegram. Подделанная кнопка (Bot API не гарантирует, что данные совпадают с кнопкой), двойное нажатие и повтор
 *   после сбоя не шлют владельцу второй вопрос и не одобряют заявку по чужой ссылке. Нажавший проверяется сам:
 *   просящийся в своей личке, владелец по базе.
 * - Каждое нажатие отвечает и логируется; ошибка не валит update, иначе очередь повторяла бы нажатие.
 */
import { answerTelegramCallbackQuery, type TelegramCallbackQuery } from "eve/channels/telegram";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { readTelegramAgentIdentity } from "../telegram-agent-identity.js";
import { groupJoinRepository, type JoinGroup } from "./group-join-repository.js";
import { groupJoinTransport, telegramBotId, type GroupJoinTransport } from "./group-join-transport.js";

export const GROUP_JOIN_CALLBACK_PREFIX = "gj:";

const CHAT_ID = /^-[1-9]\d{0,15}$/u;
const USER_ID = /^[1-9]\d{0,15}$/u;

export type GroupJoinCallback =
  | { by: "requester"; chatId: string; choice: "join" | "not_now" }
  | { by: "owner"; chatId: string; choice: "approve" | "reject"; userId: string };

export function parseGroupJoinCallback(data: string | undefined): GroupJoinCallback | null {
  if (!data?.startsWith(GROUP_JOIN_CALLBACK_PREFIX)) return null;
  const [, kind, chatId, userId, extra] = data.split(":");
  if (extra !== undefined || !chatId || !CHAT_ID.test(chatId)) return null;
  if ((kind === "j" || kind === "n") && userId === undefined) {
    return { by: "requester", chatId, choice: kind === "j" ? "join" : "not_now" };
  }
  if ((kind === "a" || kind === "r") && userId !== undefined && USER_ID.test(userId)) {
    return { by: "owner", chatId, choice: kind === "a" ? "approve" : "reject", userId };
  }
  return null;
}

const telegramId = z.union([z.number().int(), z.string().regex(/^-?\d+$/u)]).transform(String);
const joinRequestSchema = z.object({
  chat: z.object({ id: telegramId, title: z.string().optional(), type: z.enum(["group", "supergroup"]) }),
  from: z.object({
    first_name: z.string().optional(), id: telegramId, is_bot: z.boolean(), last_name: z.string().optional(),
    username: z.string().optional(),
  }),
  invite_link: z.object({ creator: z.object({ id: telegramId }) }).optional(),
  user_chat_id: telegramId,
});

export interface ChatJoinRequest {
  readonly chatId: string;
  readonly isBot: boolean;
  readonly linkCreatorId: string | null;
  readonly userChatId: string;
  readonly userId: string;
}

export function parseChatJoinRequest(raw: Record<string, unknown>): ChatJoinRequest | null {
  const parsed = joinRequestSchema.safeParse(raw.chat_join_request);
  if (!parsed.success) return null;
  const request = parsed.data;
  return {
    chatId: request.chat.id, isBot: request.from.is_bot, linkCreatorId: request.invite_link?.creator.id ?? null,
    userChatId: request.user_chat_id, userId: request.from.id,
  };
}

/** Имя для владельца: как человек назвался в Telegram, и @ник, если он есть. */
function personName(from: TelegramCallbackQuery["from"]): string {
  const name = [from.firstName, from.lastName].filter((part) => part && part.trim()).join(" ").trim() || "Человек без имени";
  return from.username ? `${name} (@${from.username})` : name;
}

export const GROUP_JOIN_TEXT = {
  approved: (title: string) => `Готово, вы в группе «${title}».`,
  asked: (owner: string) => `Передала заявку: ${owner} решит, и Telegram сам пустит вас в группу.`,
  failed: "Не получилось. Попробуйте нажать ещё раз чуть позже.",
  gone: "Заявки уже нет: её отозвали, решили раньше или человек уже в группе.",
  goneSelf: "Заявки уже нет. Чтобы вступить, откройте ссылку-приглашение ещё раз.",
  invite: (owner: string, title: string, agent: string) =>
    `${owner} зовёт вас в группу «${title}».\n\nЯ ${agent}, помогаю группе не забывать общее: дела, традиции, даты. ` +
    "Ваши личные записи никто не увидит: в группе видно только то, что пишут в неё саму.",
  notNow: "Хорошо. Если передумаете, откройте ссылку-приглашение ещё раз.",
  notOwner: "Решать заявки в эту группу может только владелец семьи.",
  ownerApproved: "✓ Пустила.",
  ownerAsk: (person: string, title: string) =>
    `В группу «${title}» просится ${person}. В семье этого человека нет. Пустить?`,
  ownerRejected: "Заявка отклонена.",
  unavailable: "Эта группа больше не подключена.",
} as const;

export interface GroupJoinDependencies {
  agentName(): string;
  answer(callbackQueryId: string, text?: string): Promise<void>;
  botId(): string;
  findGroup(telegramChatId: string): Promise<JoinGroup | null>;
  invitations: Pick<typeof groupJoinRepository, "forget" | "greet" | "release" | "take">;
  isFamilyMember(familyId: string, telegramUserId: string): Promise<boolean>;
  transport: GroupJoinTransport;
}

function log(code: string, fields: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ code, ...fields }));
}

export function createGroupJoin(dependencies: GroupJoinDependencies) {
  const { transport } = dependencies;

  async function request(raw: Record<string, unknown>): Promise<void> {
    const join = parseChatJoinRequest(raw);
    if (!join) {
      log("AGENT_GROUP_JOIN_REQUEST_INVALID");
      return;
    }
    if (join.isBot || join.linkCreatorId !== dependencies.botId()) return;
    const group = await dependencies.findGroup(join.chatId);
    if (!group) return;
    // Строка раньше сообщения: кнопка, нажатая сразу, уже её найдёт.
    await dependencies.invitations.greet(group, join.userId);
    try {
      await transport.send(join.userChatId, GROUP_JOIN_TEXT.invite(group.ownerName, group.title, dependencies.agentName()), [[
        { callback_data: `${GROUP_JOIN_CALLBACK_PREFIX}j:${group.telegramChatId}`, text: "Вступить" },
        { callback_data: `${GROUP_JOIN_CALLBACK_PREFIX}n:${group.telegramChatId}`, text: "Не сейчас" },
      ]]);
    } catch (error) {
      // Человек закрыл личку для бота или окно истекло: заявку решат администраторы в самом Telegram. Повтор не поможет.
      await dependencies.invitations.forget(group.groupId, join.userId);
      log("AGENT_GROUP_JOIN_GREETING_FAILED", { error: error instanceof Error ? error.message : String(error), groupId: group.groupId });
      return;
    }
    log("AGENT_GROUP_JOIN_INVITED", { groupId: group.groupId });
  }

  /** Сообщение с нажатой кнопкой меняется на итог: второе нажатие того же решения уже невозможно. */
  async function settle(query: TelegramCallbackQuery, text: string, keyboard?: Parameters<GroupJoinTransport["edit"]>[3]) {
    const message = query.message;
    if (!message) return;
    try {
      await transport.edit(message.chat.id, message.messageId, text, keyboard);
    } catch (error) {
      log("AGENT_GROUP_JOIN_EDIT_FAILED", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function requester(query: TelegramCallbackQuery, press: Extract<GroupJoinCallback, { by: "requester" }>, group: JoinGroup) {
    const userId = query.from.id;
    const member = press.choice === "join" && await dependencies.isFamilyMember(group.familyId, userId);
    // Забрать строку раньше Telegram: без приветствия или со второго нажатия ничего не происходит.
    if (!await dependencies.invitations.take(group.groupId, userId, "greeted", press.choice === "join" && !member ? "asked" : null)) {
      await settle(query, GROUP_JOIN_TEXT.goneSelf);
      log("AGENT_GROUP_JOIN_GONE", { groupId: group.groupId });
      return;
    }
    if (press.choice === "not_now") {
      await transport.decline(press.chatId, userId);
      await settle(query, GROUP_JOIN_TEXT.notNow);
      log("AGENT_GROUP_JOIN_DECLINED_BY_REQUESTER", { groupId: group.groupId });
      return;
    }
    if (member) {
      const approved = await transport.approve(press.chatId, userId);
      await settle(query, approved ? GROUP_JOIN_TEXT.approved(group.title) : GROUP_JOIN_TEXT.goneSelf);
      log(approved ? "AGENT_GROUP_JOIN_APPROVED_MEMBER" : "AGENT_GROUP_JOIN_GONE", { groupId: group.groupId });
      return;
    }
    const person = personName(query.from);
    try {
      await transport.send(group.ownerTelegramUserId, GROUP_JOIN_TEXT.ownerAsk(person, group.title), [[
        { callback_data: `${GROUP_JOIN_CALLBACK_PREFIX}a:${group.telegramChatId}:${userId}`, text: "Пустить" },
        { callback_data: `${GROUP_JOIN_CALLBACK_PREFIX}r:${group.telegramChatId}:${userId}`, text: "Отклонить" },
      ]]);
    } catch (error) {
      // Вопрос не ушёл: строка возвращается, и «Вступить» можно нажать ещё раз.
      await dependencies.invitations.release(group.groupId, userId);
      throw error;
    }
    await settle(query, GROUP_JOIN_TEXT.asked(group.ownerName));
    log("AGENT_GROUP_JOIN_OWNER_ASKED", { groupId: group.groupId });
  }

  /** Возвращает текст всплывающего ответа на нажатие, если он нужен. */
  async function owner(query: TelegramCallbackQuery, press: Extract<GroupJoinCallback, { by: "owner" }>, group: JoinGroup) {
    // Владелец по базе в момент нажатия: кнопку мог переслать кто угодно, а владелец мог смениться.
    if (query.from.id !== group.ownerTelegramUserId) return GROUP_JOIN_TEXT.notOwner;
    // Строку забирает первое нажатие: второе и повтор после сбоя видят «уже решено» и в Telegram не идут.
    const decided = !await dependencies.invitations.take(group.groupId, press.userId, "asked", null) ? false
      : press.choice === "approve"
      ? await transport.approve(press.chatId, press.userId)
      : await transport.decline(press.chatId, press.userId);
    // Итог дописывается к вопросу, который написал сам бот: имя просящегося остаётся на экране, в кнопке только id.
    const asked = (query.raw.message as { text?: unknown } | undefined)?.text;
    const outcome = !decided ? GROUP_JOIN_TEXT.gone : press.choice === "approve" ? GROUP_JOIN_TEXT.ownerApproved : GROUP_JOIN_TEXT.ownerRejected;
    await settle(query, typeof asked === "string" && asked ? `${asked}\n\n${outcome}` : outcome);
    log(!decided ? "AGENT_GROUP_JOIN_GONE" : press.choice === "approve" ? "AGENT_GROUP_JOIN_APPROVED_BY_OWNER" : "AGENT_GROUP_JOIN_REJECTED_BY_OWNER",
      { groupId: group.groupId });
    return undefined;
  }

  async function callback(query: TelegramCallbackQuery): Promise<boolean> {
    const press = parseGroupJoinCallback(query.data);
    if (!press) return query.data?.startsWith(GROUP_JOIN_CALLBACK_PREFIX) === true ? (await reply(query), true) : false;
    // Обе стороны нажимают в своей личке с ботом; нажатие из другого чата чужое.
    if (!query.message || query.message.chat.id !== query.from.id || query.from.isBot) {
      await reply(query);
      return true;
    }
    let answer: string | undefined;
    try {
      const group = await dependencies.findGroup(press.chatId);
      if (!group) await settle(query, GROUP_JOIN_TEXT.unavailable);
      else if (press.by === "requester") await requester(query, press, group);
      else answer = await owner(query, press, group);
    } catch (error) {
      log("AGENT_GROUP_JOIN_CALLBACK_FAILED", { error: error instanceof Error ? error.message : String(error) });
      answer = GROUP_JOIN_TEXT.failed;
    }
    await reply(query, answer);
    return true;
  }

  async function reply(query: TelegramCallbackQuery, text?: string): Promise<void> {
    try {
      await dependencies.answer(query.id, text);
    } catch (error) {
      log("AGENT_GROUP_JOIN_CALLBACK_ANSWER_FAILED", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { callback, request };
}

let production: ReturnType<typeof createGroupJoin> | undefined;

function productionGroupJoin() {
  production ??= createGroupJoin({
    agentName: () => readTelegramAgentIdentity().name,
    async answer(callbackQueryId, text) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) throw new AppError("AGENT_TELEGRAM_BOT_TOKEN_MISSING", "Не задан TELEGRAM_BOT_TOKEN для заявок в группы");
      await answerTelegramCallbackQuery({
        callbackQueryId, credentials: { botToken: token },
        fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
        ...(text ? { showAlert: false, text } : {}),
      });
    },
    botId: () => telegramBotId(),
    findGroup: (chatId) => groupJoinRepository.findGroup(chatId),
    invitations: groupJoinRepository,
    isFamilyMember: (familyId, userId) => groupJoinRepository.isFamilyMember(familyId, userId),
    transport: groupJoinTransport,
  });
  return production;
}

export function handleChatJoinRequest(raw: Record<string, unknown>): Promise<void> {
  return productionGroupJoin().request(raw);
}

export function handleGroupJoinCallback(query: TelegramCallbackQuery): Promise<boolean> {
  return productionGroupJoin().callback(query);
}
