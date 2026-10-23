/**
 * Данные «фишки»: кому можно подсказать, что уже показано, заявка на день и ответы кнопками (миграции 195–196).
 *
 * Экспорт:
 * - `FeatureTipRecipient`: человек с личной сессией и его правило инициативы.
 * - `FEATURE_TIP_FIRST_DAYS`: столько дней в семье без советов: это знакомство (`QUEST_DAYS`), пока оно не пройдено.
 * - `featureTipRepository`: адресаты, показанные советы, заявка, ответ «попробовать / не интересно», выключатель.
 *
 * Советы включены по умолчанию (`feature_tips_enabled` NULL); выпадает только сказавший «не присылать советы».
 * Пока человек в знакомстве («Знакомство с Юной», `onboarding-quest/`), вместо советов идут его касания в 1, 3 и 7 день;
 * советы начинаются после финала знакомства или когда его дни прошли (до 23 октября 2026 было «не в первые два дня»,
 * для прошедших знакомство это правило больше не нужно). Заявка и отметка показа идут одной
 * транзакцией: совет, ушедший однажды, второй раз не приходит, даже если два тика сошлись на одной минуте.
 */
import { database } from "../database.js";
import { QUEST_DAYS } from "../onboarding-quest/quest-steps.js";
import {
  INITIATIVE_DEFAULT_DAILY_LIMIT,
  initiativeRecipientQuery,
  toInitiativeRecipient,
  type InitiativeRecipient,
  type InitiativeRecipientRow,
} from "./initiative-audience.js";

export type FeatureTipRecipient = InitiativeRecipient;

export const FEATURE_TIP_FIRST_DAYS = QUEST_DAYS;

/** Пояс человека, иначе владельца семьи: тот же порядок, что у выборки адресатов. */
const OWN_TIMEZONE_SQL = `COALESCE(
  (SELECT timezone FROM user_notification_settings WHERE user_id = $1),
  (SELECT settings.timezone FROM user_notification_settings AS settings
     JOIN family_memberships AS membership ON membership.user_id = settings.user_id
    WHERE membership.family_id = $2 AND membership.role = 'owner' LIMIT 1),
  'UTC')`;

export const featureTipRepository = {
  async recipients(now: Date): Promise<FeatureTipRecipient[]> {
    const { rows } = await database().query<InitiativeRecipientRow>(
      initiativeRecipientQuery(`
          AND settings.feature_tips_enabled IS DISTINCT FROM false
          AND (membership.created_at <= $1::timestamptz - make_interval(days => $3)
               OR EXISTS (SELECT 1 FROM onboarding_quest_marks AS quest
                           WHERE quest.user_id = person.id AND quest.mark = 'final'))`),
      [now, INITIATIVE_DEFAULT_DAILY_LIMIT, FEATURE_TIP_FIRST_DAYS],
    );
    return rows.map(toInitiativeRecipient);
  },

  /** Ключи уже показанных советов; пустое множество значит, что следующий совет первый. */
  async shown(recipient: { userId: string }): Promise<Set<string>> {
    const { rows } = await database().query<{ tip_id: string }>(
      "SELECT tip_id FROM feature_tip_shows WHERE user_id = $1", [recipient.userId]);
    return new Set(rows.map((row) => row.tip_id));
  },

  /** Заявка на день и отметка показа одной транзакцией; null — сегодня уже было или этот совет уже показан. */
  async claim(recipient: FeatureTipRecipient, localDate: string, tipId: string, now: Date): Promise<string | null> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ delivery_ref: string }>(
        `INSERT INTO initiative_messages(family_id, user_id, kind, sent_on, sent_at)
         VALUES ($1, $2, 'feature_tip', $3::date, $4)
         ON CONFLICT DO NOTHING RETURNING delivery_ref`,
        [recipient.familyId, recipient.userId, localDate, now],
      );
      const deliveryRef = inserted.rows[0]?.delivery_ref ?? null;
      if (deliveryRef === null) {
        await client.query("ROLLBACK");
        return null;
      }
      const shown = await client.query(
        `INSERT INTO feature_tip_shows(family_id, user_id, tip_id, delivery_ref, shown_at)
         VALUES ($1, $2, $3, $4::uuid, $5) ON CONFLICT DO NOTHING RETURNING 1`,
        [recipient.familyId, recipient.userId, tipId, deliveryRef, now],
      );
      if (shown.rowCount === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("COMMIT");
      return deliveryRef;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Первый ответ на совет: «tried» или «dismissed». Возвращает заявку, под которой ушёл совет, только первому ответу:
   * повторное нажатие или повтор обновления после сбоя второй раз ничего не присылает.
   */
  async answer(input: { now: Date; outcome: "dismissed" | "tried"; tipId: string; userId: string }): Promise<string | null> {
    const { rows } = await database().query<{ delivery_ref: string }>(
      `UPDATE feature_tip_shows SET outcome = $3, answered_at = $4
        WHERE user_id = $1 AND tip_id = $2 AND outcome IS NULL
        RETURNING delivery_ref`,
      [input.userId, input.tipId, input.outcome, input.now],
    );
    return rows[0]?.delivery_ref ?? null;
  },

  /** «Не присылать советы» или «Не писать вечером»: своя строка настроек, с аудитом, как у сводки. */
  async switchOff(input: { familyId: string; setting: "evening_reflection" | "feature_tips"; userId: string }): Promise<void> {
    const column = input.setting === "feature_tips" ? "feature_tips_enabled" : "evening_reflection_enabled";
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO user_notification_settings(user_id, timezone, ${column})
         VALUES ($1, ${OWN_TIMEZONE_SQL}, false)
         ON CONFLICT (user_id) DO UPDATE SET ${column} = false, updated_at = now()`,
        [input.userId, input.familyId],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, metadata)
         VALUES ($1, $2, $3, jsonb_build_object('enabled', false))`,
        [input.familyId, input.userId, `notifications.${input.setting}`],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
