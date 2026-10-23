/**
 * «Напомнить и мне» under a guest answer: a family member's press becomes their personal reminder.
 *
 * Exports:
 * - `createGuestReminderCallbackHandler`: the press processor; dependencies injected.
 * - `createGuestOfferReminder`: the presser's personal reminder through the reminder repository.
 * - `handleGuestReminderCallback`: the production handler used by the durable ingress.
 *
 * The bot cannot write into the chat it was a guest in, so a reminder for «нам» reaches each person
 * who asked for it in their private chat. Only family members get one (owner decision of 12 October
 * 2026): identity, family, role and space are read live from PostgreSQL by the presser's Telegram id,
 * and the reminder goes through the ordinary reminder repository as if they created it in their
 * private chat. The offer carries only the text and time the guest answer stored; nothing from the
 * press except who pressed it.
 */
import { answerTelegramCallbackQuery, type TelegramCallbackQuery } from "eve/channels/telegram";

import { AppError } from "../app-error.js";
import { resolveCurrentTime } from "../current-time.js";
import { database } from "../database.js";
import type { FamilyIdentity } from "../family-access.js";
import type { ReminderAuthorization } from "../reminders/reminder-context.js";
import { reminderRepository } from "../reminders/reminder-repository.js";
import { resolveTurnSpaceContext } from "../spaces/turn-space-selection.js";
import { telegramRepository } from "../telegram-repository.js";
import { guestChatRepository, type GuestReminderOffer } from "./guest-chat-repository.js";
import { GUEST_REMINDER_CALLBACK_PREFIX, parseGuestReminderCallbackData } from "./guest-reminder-callback-data.js";

const GUEST_CALLBACK_TIMEOUT_MS = 15_000;
/** Bot API: the text of `answerCallbackQuery` is 0-200 characters; a longer one is rejected. */
const CALLBACK_TEXT_MAX_CHARACTERS = 200;

const TEXT = {
  expired: "Это напоминание уже не действует: время прошло или его попросили забыть.",
  failed: "Не получилось поставить напоминание. Попробуйте нажать ещё раз чуть позже.",
  notMember: "Напоминания я ставлю участникам семьи. Откройте меня кнопкой «Открыть» под ответом.",
  timezone: "Сначала скажите мне в личном чате свой часовой пояс, тогда смогу напомнить.",
} as const;

export interface GuestReminderCallbackDependencies {
  answer(input: { callbackQueryId: string; showAlert: boolean; text: string }): Promise<void>;
  /** Creates the personal reminder and returns its local time text, or null without a timezone. */
  createReminder(input: {
    identity: FamilyIdentity;
    offer: GuestReminderOffer;
    telegramUserId: string;
  }): Promise<string | null>;
  findIdentity(telegramUserId: string): Promise<FamilyIdentity | null>;
  findOffer(offerId: string): Promise<GuestReminderOffer | null>;
}

/** Cut on code points: half of a surrogate pair is rejected like an overlong text. */
function clipText(text: string): string {
  const points = Array.from(text);
  return points.length <= CALLBACK_TEXT_MAX_CHARACTERS
    ? text
    : `${points.slice(0, CALLBACK_TEXT_MAX_CHARACTERS - 1).join("")}…`;
}

export function createGuestReminderCallbackHandler(dependencies: GuestReminderCallbackDependencies) {
  async function reply(query: TelegramCallbackQuery, text: string, showAlert: boolean): Promise<void> {
    try {
      await dependencies.answer({ callbackQueryId: query.id, showAlert, text: clipText(text) });
    } catch (error) {
      // The reminder is already stored or refused; the spinner on the button is all that is lost.
      console.error(JSON.stringify({
        code: "AGENT_GUEST_REMINDER_CALLBACK_ANSWER_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  return async function handleGuestReminderCallback(query: TelegramCallbackQuery): Promise<boolean> {
    if (!query.data?.startsWith(GUEST_REMINDER_CALLBACK_PREFIX)) return false;
    const offerId = parseGuestReminderCallbackData(query.data);
    let offer: GuestReminderOffer | null = null;
    try {
      // A press that throws would fail its update and keep the presser's id unanswered: every failure
      // here is answered and logged, and the update completes.
      offer = offerId ? await dependencies.findOffer(offerId) : null;
      if (!offer) {
        await reply(query, TEXT.expired, true);
        return true;
      }
      const identity = await dependencies.findIdentity(query.from.id);
      if (!identity) {
        await reply(query, TEXT.notMember, true);
        return true;
      }
      const when = await dependencies.createReminder({ identity, offer, telegramUserId: query.from.id });
      await reply(query, when ? `Напомню вам в личном чате ${when}: ${offer.content}` : TEXT.timezone, when === null);
      console.info(JSON.stringify({ code: "AGENT_GUEST_REMINDER_ACCEPTED", created: when !== null, offerId: offer.id }));
    } catch (error) {
      console.error(JSON.stringify({
        code: "AGENT_GUEST_REMINDER_FAILED",
        errorCode: error instanceof AppError ? error.code : error instanceof Error ? error.name : "unknown",
        offerId: offer?.id ?? null,
      }));
      await reply(query, error instanceof AppError ? error.message : TEXT.failed, true);
    }
    return true;
  };
}

/** The presser's own private chat, family, role and space, all read live. */
async function guestReminderAuthorization(
  identity: FamilyIdentity,
  telegramUserId: string,
): Promise<ReminderAuthorization> {
  const client = await database().connect();
  try {
    const space = await resolveTurnSpaceContext(client, {
      chatType: "private",
      familyId: identity.familyId,
      groupId: null,
      userId: identity.userId,
    });
    let attributes: ReminderAuthorization["space"];
    if (space) {
      const policy = await client.query<{ policy_version: string }>(
        "SELECT policy_version::text FROM spaces WHERE id = $1 AND family_id = $2",
        [space.spaceId, identity.familyId],
      );
      const version = Number(policy.rows[0]?.policy_version);
      if (!Number.isSafeInteger(version) || version <= 0) {
        throw new AppError("AGENT_SPACE_CONTEXT_REQUIRED", "Личное пространство не найдено. Напишите мне в личный чат");
      }
      attributes = { policyVersion: version, spaceId: space.spaceId };
    }
    return {
      ...(attributes ? { space: attributes } : {}),
      familyId: identity.familyId,
      forumTopicId: null,
      groupId: null,
      groupType: null,
      messageThreadId: null,
      role: identity.role,
      telegramChatId: telegramUserId,
      telegramChatType: "private",
      userId: identity.userId,
    };
  } finally {
    client.release();
  }
}

export async function createGuestOfferReminder(input: {
  identity: FamilyIdentity;
  offer: GuestReminderOffer;
  telegramUserId: string;
}): Promise<string | null> {
  const settings = await database().query<{ timezone: string }>(
    "SELECT timezone FROM user_notification_settings WHERE user_id = $1",
    [input.identity.userId],
  );
  const timezone = settings.rows[0]?.timezone;
  if (!timezone) return null;
  const auth = await guestReminderAuthorization(input.identity, input.telegramUserId);
  await reminderRepository.create(auth, {
    content: input.offer.content,
    firstRunAt: input.offer.runAt,
    // Operation keys are unique per family: two members pressing the same offer are two reminders.
    operationKey: `guest-offer:${input.offer.id}:${input.identity.userId}`,
    recurrence: null,
    scope: "personal",
    timezone,
  });
  const local = resolveCurrentTime(input.offer.runAt, timezone, "user_settings");
  return `${local.localDate} в ${local.localTime?.slice(0, 5)}`;
}

let productionHandler: ReturnType<typeof createGuestReminderCallbackHandler> | undefined;

export function handleGuestReminderCallback(query: TelegramCallbackQuery): Promise<boolean> {
  productionHandler ??= createGuestReminderCallbackHandler({
    async answer(input) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!botToken) {
        throw new AppError("AGENT_TELEGRAM_BOT_TOKEN_MISSING", "Не задан TELEGRAM_BOT_TOKEN для ответа на кнопку");
      }
      const response = await answerTelegramCallbackQuery({
        callbackQueryId: input.callbackQueryId,
        credentials: { botToken },
        fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(GUEST_CALLBACK_TIMEOUT_MS) }),
        showAlert: input.showAlert,
        text: input.text,
      });
      if (!response.ok) {
        throw new AppError("AGENT_GUEST_REMINDER_CALLBACK_ANSWER_FAILED", `Telegram не принял ответ на кнопку (HTTP ${response.status})`);
      }
    },
    createReminder: createGuestOfferReminder,
    findIdentity: (telegramUserId) => telegramRepository.findIdentity(telegramUserId),
    findOffer: (offerId) => guestChatRepository.findOffer(offerId),
  });
  return productionHandler(query);
}
