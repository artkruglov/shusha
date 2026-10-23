/**
 * Данные недельного обзора: кому можно написать, что накопилось и заявка на неделю.
 *
 * Экспорт:
 * - `WeeklyReviewRecipient`: человек с личным чатом, его правило инициативы и согласие на обзор.
 * - `weeklyReviewRepository`: адресаты, содержание недели и заявка.
 *
 * Содержание собирается тем же планировщиком, что отвечает человеку в чате, и с той же
 * авторизацией: второго пути к делам здесь нет, поэтому обзор не покажет больше, чем человек
 * увидел бы сам. Пишет только тем, кто сам писал боту в личку: Telegram не даёт боту начать
 * разговор первым, а общий чат для пересмотра личных дел не место.
 */
import { database } from "../database.js";
import { dailyOverviewRepository } from "./daily-overview-repository.js";
import type { InitiativeSettings, InitiativeState } from "./initiative-policy.js";
import type { WeeklyReviewInput } from "./weekly-review.js";
import { unansweredCountSql } from "./initiative-unanswered.js";

const DEFAULT_DAILY_LIMIT = 3;
/** Окно счётчика закрытого: ровно та неделя, которую человек пересматривает. */
const CLOSED_WINDOW_DAYS = 7;

export interface WeeklyReviewRecipient {
  readonly familyId: string;
  readonly userId: string;
  readonly telegramUserId: string;
  /** `null`: человека ещё не спрашивали; `false`: «хватит обзоров». */
  readonly enabled: boolean | null;
  readonly settings: InitiativeSettings;
  readonly state: InitiativeState;
}

interface RecipientRow {
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
  weekly_review_enabled: boolean | null;
}

export const weeklyReviewRepository = {
  /** Обзор включён по умолчанию (30 сентября 2026): из выборки выпадает только сказавший «хватит обзоров». */
  async recipients(now: Date): Promise<WeeklyReviewRecipient[]> {
    const { rows } = await database().query<RecipientRow>(
      `SELECT DISTINCT ON (membership.family_id, person.id)
              membership.family_id, person.id AS user_id, person.telegram_user_id,
              COALESCE(settings.timezone, owner_settings.timezone, 'UTC') AS timezone,
              to_char(settings.quiet_start, 'HH24:MI') AS quiet_start,
              to_char(settings.quiet_end, 'HH24:MI') AS quiet_end,
              COALESCE(settings.initiative_enabled, true) AS enabled,
              COALESCE(settings.initiative_daily_limit, $2::smallint) AS daily_limit,
              settings.weekly_review_enabled,
              (SELECT count(*) FROM initiative_messages AS sent
                WHERE sent.user_id = person.id
                  AND sent.sent_on = ($1::timestamptz AT TIME ZONE COALESCE(settings.timezone, owner_settings.timezone, 'UTC'))::date
              )::text AS sent_today,
              ${unansweredCountSql("person.id", "$1")} AS unanswered
         FROM family_memberships AS membership
         JOIN users AS person ON person.id = membership.user_id
         JOIN application_conversations AS chat ON chat.family_id = membership.family_id
          AND chat.owner_user_id = person.id AND chat.scope = 'personal'
          AND chat.telegram_group_id IS NULL AND chat.telegram_chat_id = person.telegram_user_id
         LEFT JOIN user_notification_settings AS settings ON settings.user_id = person.id
         -- Человек без своих настроек слышит обзор в поясе владельца семьи, а не в UTC: иначе
         -- воскресный вечер попадает ему в ночь (то же, что у коуча, 22 сентября 2026).
         LEFT JOIN family_memberships AS owner_membership
           ON owner_membership.family_id = membership.family_id AND owner_membership.role = 'owner'
         LEFT JOIN user_notification_settings AS owner_settings
           ON owner_settings.user_id = owner_membership.user_id
        WHERE person.telegram_user_id IS NOT NULL
          AND settings.weekly_review_enabled IS DISTINCT FROM false
          -- Строку личного чата база заводит каждому участнику сама; написать первым Telegram даёт
          -- только тому, кто сам начал разговор, а его след это личная сессия с ботом.
          AND EXISTS (SELECT 1 FROM conversation_sessions AS session
                       WHERE session.family_id = membership.family_id AND session.scope = 'personal'
                         AND session.owner_user_id = person.id AND session.kind = 'canonical')
        ORDER BY membership.family_id, person.id`,
      [now, DEFAULT_DAILY_LIMIT],
    );
    return rows.map((row) => ({
      enabled: row.weekly_review_enabled !== false,
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

  /** Содержание недели: те же дела, что и в утреннем обзоре, плюс счётчик закрытого за семь дней. */
  async review(recipient: WeeklyReviewRecipient, now: Date): Promise<WeeklyReviewInput> {
    const overview = await dailyOverviewRepository.overview(recipient);
    // Закрытое считается по событиям выполнения, а не по `updated_at`: перенос старого сделанного дела
    // при слиянии проектов делал его «закрытым за неделю», а выполнение повторяющегося дела, которое
    // сразу получает следующую дату, не считалось вовсе. Каждое вхождение повтора идёт в счёт, обычное
    // дело один раз и только если оно и сейчас закрыто.
    const closed = await database().query<{ count: string }>(
      `SELECT count(DISTINCT CASE WHEN t.recurrence_unit IS NULL THEN t.id::text ELSE v.task_id::text || ':' || v.version END)::text
         FROM shared_task_versions v JOIN shared_tasks t ON t.id = v.task_id
        WHERE t.family_id = $1 AND t.kind = 'task' AND v.action = 'complete'
          AND (t.recurrence_unit IS NOT NULL OR t.status = 'completed')
          AND (t.assignee_telegram_id = $2 OR t.creator_telegram_id = $2)
          AND v.created_at > $3::timestamptz - make_interval(days => $4)`,
      [recipient.familyId, recipient.telegramUserId, now, CLOSED_WINDOW_DAYS],
    );
    return {
      closedLastWeek: Number(closed.rows[0]?.count ?? 0),
      now,
      ...(overview.projects ? { projects: overview.projects } : {}),
      tasks: overview.tasks,
      timezone: recipient.settings.timezone,
      waiting: overview.waiting,
    };
  },

  /**
   * Заявка на неделю: повтор невозможен по уникальному индексу, а не по проверке в коде. Назад
   * заявка не отдаётся — определённый отказ Telegram ждёт следующего воскресенья, иначе каждый
   * десятиминутный тик вечера пробовал бы снова.
   */
  async claim(recipient: WeeklyReviewRecipient, localDate: string, now: Date): Promise<string | null> {
    const inserted = await database().query<{ delivery_ref: string }>(
      `INSERT INTO initiative_messages(family_id, user_id, kind, sent_on, sent_at)
       VALUES ($1, $2, 'weekly_review', $3::date, $4)
       ON CONFLICT DO NOTHING RETURNING delivery_ref`,
      [recipient.familyId, recipient.userId, localDate, now],
    );
    return inserted.rows[0]?.delivery_ref ?? null;
  },

};
