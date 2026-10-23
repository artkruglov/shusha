/**
 * Данные вопроса «что мешает»: кого спросить на этой неделе и заявка на неделю.
 *
 * Экспорт:
 * - `FeedbackAskRecipient`: участник семьи друзей с личным чатом, его правило инициативы и счёт вопросов.
 * - `feedbackAskRepository`: адресаты и заявка.
 *
 * Семья оператора (первая в установке, ей же `/feedback` и доставляется) не спрашивается: он знает,
 * что ему мешает. Новичка первой недели спрашивать ещё не о чем. Кто сам писал `/feedback` за
 * последние семь дней, уже ответил. Как и обзор, пишет только тем, у кого есть личная сессия с ботом:
 * начать разговор первым Telegram даёт только тому, кто сам писал.
 */
import { database } from "../database.js";
import { FEEDBACK_ASK_LIMIT } from "./feedback-ask-dispatch.js";
import type { InitiativeSettings, InitiativeState } from "./initiative-policy.js";
import { unansweredCountSql } from "./initiative-unanswered.js";

const DEFAULT_DAILY_LIMIT = 3;
/** Столько дней в семье до первого вопроса: неделя знакомства без одного дня, чтобы попасть в её субботу. */
const FIRST_ASK_AFTER_DAYS = 6;
/** Своё `/feedback` за это окно и есть ответ на неделю. */
const OWN_FEEDBACK_WINDOW_DAYS = 7;

export interface FeedbackAskRecipient {
  readonly familyId: string;
  readonly userId: string;
  readonly telegramUserId: string;
  /** Сколько раз уже спрошен за всё время. */
  readonly asked: number;
  readonly settings: InitiativeSettings;
  readonly state: InitiativeState;
}

interface RecipientRow {
  asked: string;
  daily_limit: number;
  enabled: boolean;
  family_id: string;
  quiet_end: string | null;
  quiet_start: string | null;
  sent_today: string;
  telegram_user_id: string;
  timezone: string;
  unanswered: string;
  user_id: string;
}

export const feedbackAskRepository = {
  async recipients(now: Date): Promise<FeedbackAskRecipient[]> {
    const { rows } = await database().query<RecipientRow>(
      `SELECT DISTINCT ON (membership.family_id, person.id)
              membership.family_id, person.id AS user_id, person.telegram_user_id,
              COALESCE(settings.timezone, owner_settings.timezone, 'UTC') AS timezone,
              to_char(settings.quiet_start, 'HH24:MI') AS quiet_start,
              to_char(settings.quiet_end, 'HH24:MI') AS quiet_end,
              COALESCE(settings.initiative_enabled, true) AS enabled,
              COALESCE(settings.initiative_daily_limit, $2::smallint) AS daily_limit,
              (SELECT count(*) FROM initiative_messages AS sent
                WHERE sent.user_id = person.id
                  AND sent.sent_on = ($1::timestamptz AT TIME ZONE COALESCE(settings.timezone, owner_settings.timezone, 'UTC'))::date
              )::text AS sent_today,
              ${unansweredCountSql("person.id", "$1")} AS unanswered,
              (SELECT count(*) FROM initiative_messages AS asked
                WHERE asked.user_id = person.id AND asked.kind = 'feedback_ask')::text AS asked
         FROM family_memberships AS membership
         JOIN users AS person ON person.id = membership.user_id
         JOIN application_conversations AS chat ON chat.family_id = membership.family_id
          AND chat.owner_user_id = person.id AND chat.scope = 'personal'
          AND chat.telegram_group_id IS NULL AND chat.telegram_chat_id = person.telegram_user_id
         LEFT JOIN user_notification_settings AS settings ON settings.user_id = person.id
         LEFT JOIN family_memberships AS owner_membership
           ON owner_membership.family_id = membership.family_id AND owner_membership.role = 'owner'
         LEFT JOIN user_notification_settings AS owner_settings
           ON owner_settings.user_id = owner_membership.user_id
        WHERE person.telegram_user_id IS NOT NULL
          AND membership.family_id <> (SELECT id FROM families ORDER BY created_at, id LIMIT 1)
          AND membership.created_at <= $1::timestamptz - make_interval(days => $3)
          AND (SELECT count(*) FROM initiative_messages AS asked
                WHERE asked.user_id = person.id AND asked.kind = 'feedback_ask') < $4
          AND NOT EXISTS (SELECT 1 FROM feedback_messages AS own
                           WHERE own.telegram_user_id = person.telegram_user_id
                             AND own.created_at > $1::timestamptz - make_interval(days => $5))
          AND EXISTS (SELECT 1 FROM conversation_sessions AS session
                       WHERE session.family_id = membership.family_id AND session.scope = 'personal'
                         AND session.owner_user_id = person.id AND session.kind = 'canonical')
        ORDER BY membership.family_id, person.id`,
      [now, DEFAULT_DAILY_LIMIT, FIRST_ASK_AFTER_DAYS, FEEDBACK_ASK_LIMIT, OWN_FEEDBACK_WINDOW_DAYS],
    );
    return rows.map((row) => ({
      asked: Number(row.asked),
      familyId: row.family_id,
      settings: {
        dailyLimit: row.daily_limit,
        enabled: row.enabled,
        quietEnd: row.quiet_end,
        quietStart: row.quiet_start,
        timezone: row.timezone,
      },
      state: { sentToday: Number(row.sent_today), unanswered: Number(row.unanswered) },
      telegramUserId: row.telegram_user_id,
      userId: row.user_id,
    }));
  },

  /** Заявка на неделю по уникальному индексу (миграция 185); назад не отдаётся, как у обзора. */
  async claim(recipient: FeedbackAskRecipient, localDate: string, now: Date): Promise<string | null> {
    const inserted = await database().query<{ delivery_ref: string }>(
      `INSERT INTO initiative_messages(family_id, user_id, kind, sent_on, sent_at)
       VALUES ($1, $2, 'feedback_ask', $3::date, $4)
       ON CONFLICT DO NOTHING RETURNING delivery_ref`,
      [recipient.familyId, recipient.userId, localDate, now],
    );
    return inserted.rows[0]?.delivery_ref ?? null;
  },
};
