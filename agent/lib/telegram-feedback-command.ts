/**
 * `/feedback текст`: what a family member wants the operator to know, sent without the model.
 *
 * Exports:
 * - `FEEDBACK_DAILY_LIMIT`: how many a person may send in a day.
 * - `FeedbackRepository`, `feedbackRepository`: records the text, finds the operator's chat, marks delivery.
 * - `handleFeedbackCommand`: consumes the command in a private chat before Eve; false for any other message.
 *
 * Key constructs:
 * - Only a verified family identity in a private chat may send; the operator is the owner of the earliest
 *   family, as for /signup. The operator sees the sender's Telegram name and the family's ordinal: the
 *   person wrote to them on purpose, and an answer needs to know whom to answer.
 * - The row is written before sending, so a text that Telegram refused stays for the operator to read, and
 *   the daily limit counts what was sent, not what arrived.
 */
import type { TelegramContext, TelegramMessage } from "eve/channels/telegram";

import { database } from "./database.js";
import { withSystemDatabaseContext } from "./database-context.js";
import type { FamilyIdentity } from "./family-access.js";
import { initiativeRepository } from "./initiative/initiative-repository.js";
import { memoryReviewOwnerAlertTransport } from "./memory-review/memory-review-owner-alert-transport.js";
import { telegramProfileName } from "./telegram-on-message-context.js";

export const FEEDBACK_DAILY_LIMIT = 5;
const FEEDBACK_MAX_CHARACTERS = 2000;
const FEEDBACK_COMMAND_PATTERN = /^\/feedback(?:@\w+)?(?:\s+([\s\S]*))?$/u;

const TEXT = {
  empty: "Напишите после команды, что мешает или что понравилось. Например: /feedback не понял, как перенести дело.",
  failed: "Не получилось передать. Я сохранила текст, оператор его увидит.",
  limited: `За сегодня уже ${FEEDBACK_DAILY_LIMIT} отзывов. Напишите завтра, пожалуйста.`,
  sent: "Спасибо, передала оператору.",
  tooLong: `Слишком длинно: до ${FEEDBACK_MAX_CHARACTERS} символов, пожалуйста.`,
} as const;

export interface FeedbackRepository {
  /** The row's id, or null when the person already sent the day's limit. */
  record(input: { familyId: string; now: Date; telegramUserId: string; text: string }): Promise<{ familyOrdinal: number; id: string } | null>;
  markDelivered(id: string, now: Date): Promise<void>;
  /** The person wrote: a question the bot started, «что мешает» among them, is answered. */
  markAnswered(userId: string, now: Date): Promise<void>;
  operatorChatId(): Promise<string | null>;
  send(input: { chatId: string; text: string }): Promise<void>;
}

export const feedbackRepository: FeedbackRepository = {
  async record(input) {
    return withSystemDatabaseContext(async () => {
      const sent = await database().query<{ count: number }>(
        `SELECT count(*)::int AS count FROM feedback_messages
          WHERE telegram_user_id = $1 AND created_at > $2::timestamptz - interval '1 day'`,
        [input.telegramUserId, input.now],
      );
      if ((sent.rows[0]?.count ?? 0) >= FEEDBACK_DAILY_LIMIT) return null;
      const row = await database().query<{ id: string; ordinal: string }>(
        `WITH inserted AS (
           INSERT INTO feedback_messages (family_id, telegram_user_id, text, created_at) VALUES ($1, $2, $3, $4)
           RETURNING id, family_id
         )
         SELECT inserted.id, (SELECT count(*) FROM families f, families mine
                                WHERE mine.id = inserted.family_id
                                  AND (f.created_at, f.id) <= (mine.created_at, mine.id))::text AS ordinal
           FROM inserted`,
        [input.familyId, input.telegramUserId, input.text, input.now],
      );
      return { familyOrdinal: Number(row.rows[0]!.ordinal), id: row.rows[0]!.id };
    });
  },
  markAnswered: (userId, now) => withSystemDatabaseContext(() => initiativeRepository.markAnswered(userId, now)),
  async markDelivered(id, now) {
    await withSystemDatabaseContext(() => database().query("UPDATE feedback_messages SET delivered_at = $2 WHERE id = $1", [id, now]));
  },
  async operatorChatId() {
    const result = await withSystemDatabaseContext(() => database().query<{ telegram_user_id: string }>(
      `SELECT owner.telegram_user_id FROM family_memberships membership
         JOIN users owner ON owner.id = membership.user_id
        WHERE membership.role = 'owner' AND owner.telegram_user_id IS NOT NULL
          AND membership.family_id = (SELECT id FROM families ORDER BY created_at, id LIMIT 1)
        LIMIT 1`,
    ));
    return result.rows[0]?.telegram_user_id ?? null;
  },
  send: (input) => memoryReviewOwnerAlertTransport.deliver(input),
};

export async function handleFeedbackCommand(
  input: { ctx: TelegramContext; identity: FamilyIdentity | null; message: TelegramMessage; now?: Date },
  repository: FeedbackRepository = feedbackRepository,
): Promise<boolean> {
  const command = FEEDBACK_COMMAND_PATTERN.exec(input.message.text.trim());
  const sender = input.message.from;
  if (!command || !input.identity || !sender || input.message.chat.type !== "private") return false;
  // The command never reaches Eve, so the turn's own «he wrote, the pause is over» is taken here.
  await repository.markAnswered(input.identity.userId, input.now ?? new Date());
  const text = (command[1] ?? "").trim();
  if (text.length === 0) {
    await input.ctx.telegram.sendMessage(TEXT.empty);
    return true;
  }
  if (Array.from(text).length > FEEDBACK_MAX_CHARACTERS) {
    await input.ctx.telegram.sendMessage(TEXT.tooLong);
    return true;
  }
  const now = input.now ?? new Date();
  const recorded = await repository.record({ familyId: input.identity.familyId, now, telegramUserId: sender.id, text });
  if (recorded === null) {
    await input.ctx.telegram.sendMessage(TEXT.limited);
    return true;
  }
  try {
    const chatId = await repository.operatorChatId();
    if (chatId === null) throw new Error("AGENT_FEEDBACK_OPERATOR_MISSING: Нет владельца первой семьи");
    await repository.send({
      chatId,
      text: `Отзыв, семья ${recorded.familyOrdinal}, ${telegramProfileName(input.message)}:\n${text}`,
    });
    await repository.markDelivered(recorded.id, new Date());
    console.info(JSON.stringify({ code: "AGENT_FEEDBACK_DELIVERED", familyOrdinal: recorded.familyOrdinal }));
    await input.ctx.telegram.sendMessage(TEXT.sent);
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_FEEDBACK_DELIVERY_FAILED",
      error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
    }));
    await input.ctx.telegram.sendMessage(TEXT.failed);
  }
  return true;
}
