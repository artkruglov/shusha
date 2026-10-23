/**
 * Данные знакомства: кто сейчас в нём, что о человеке говорят данные и что квест уже сказал (миграция 197).
 *
 * Экспорт:
 * - `QuestPerson`: участник семьи с датой входа, ролью и отметками квеста.
 * - `questRepository`: `person`, `facts`, `mark`, адресаты касаний, заявка касания, разовое нажатие кнопки.
 *
 * Признаки шагов читаются из уже лежащих данных: голосовое и дело (сырые обновления личного чата и `shared_tasks`),
 * взрослые в семье (`family_memberships.relation`), семейный чат (`telegram_groups`), остальное из
 * `featureUseRepository.used`. Человек в знакомстве, пока он в семье меньше `QUEST_DAYS` дней, не сказал «хватит
 * подсказок» (`feature_tips_enabled = false`) и не получил финал. Касание это обычная инициатива: заявка в
 * `initiative_messages` того же вида, что у «фишки» (`feature_tip`, одна на местный день), и отметка дня одной
 * транзакцией, поэтому касание и совет не приходят в один день, а два тика не шлют касание дважды.
 */
import { database } from "../database.js";
import { featureUseRepository } from "../feature-uses/feature-use-repository.js";
import {
  INITIATIVE_DEFAULT_DAILY_LIMIT,
  initiativeRecipientQuery,
  toInitiativeRecipient,
  type InitiativeRecipient,
  type InitiativeRecipientRow,
} from "../initiative/initiative-audience.js";
import { QUEST_DAYS, type QuestFacts } from "./quest-steps.js";

export interface QuestPerson {
  readonly familyId: string;
  readonly userId: string;
  readonly telegramUserId: string;
  readonly joinedAt: Date;
  readonly owner: boolean;
  /** Пояс человека, иначе владельца семьи. */
  readonly timezone: string;
  readonly marks: ReadonlySet<string>;
  /** Ещё в знакомстве: моложе `QUEST_DAYS`, подсказки не выключены, финала не было. */
  readonly active: boolean;
}

/** Своё распознанное голосовое в личке и дело, записанное им в следующие четверть часа. */
const VOICE_TASK_SQL = `EXISTS (SELECT 1 FROM telegram_ingress_updates AS update_row
  JOIN shared_tasks AS task ON task.family_id = $1 AND task.creator_telegram_id = $2
   AND task.created_at BETWEEN update_row.received_at AND update_row.received_at + interval '15 minutes'
  WHERE update_row.payload->'message'->'from'->>'id' = $2
    AND update_row.payload->'message'->'chat'->>'type' = 'private'
    AND update_row.voice_transcript IS NOT NULL)`;

const FINAL_MARK = "final";

export const questRepository = {
  async person(input: { familyId: string; now: Date; userId: string }): Promise<QuestPerson | null> {
    const { rows } = await database().query<{
      joined_at: Date; marks: string[]; role: string; telegram_user_id: string | null; timezone: string; tips_off: boolean;
    }>(
      `SELECT membership.created_at AS joined_at, membership.role::text AS role, person.telegram_user_id,
              COALESCE(settings.timezone, owner_settings.timezone, 'UTC') AS timezone,
              COALESCE(settings.feature_tips_enabled = false, false) AS tips_off,
              ARRAY(SELECT mark FROM onboarding_quest_marks AS marks WHERE marks.user_id = person.id) AS marks
         FROM family_memberships AS membership
         JOIN users AS person ON person.id = membership.user_id
         LEFT JOIN user_notification_settings AS settings ON settings.user_id = person.id
         LEFT JOIN family_memberships AS owner_membership
           ON owner_membership.family_id = membership.family_id AND owner_membership.role = 'owner'
         LEFT JOIN user_notification_settings AS owner_settings ON owner_settings.user_id = owner_membership.user_id
        WHERE membership.family_id = $1 AND membership.user_id = $2`,
      [input.familyId, input.userId],
    );
    const row = rows[0];
    if (!row || row.telegram_user_id === null) return null;
    const marks = new Set(row.marks);
    const young = input.now.getTime() - row.joined_at.getTime() < QUEST_DAYS * 86_400_000;
    return {
      active: young && !row.tips_off && !marks.has(FINAL_MARK),
      familyId: input.familyId, joinedAt: row.joined_at, marks, owner: row.role === "owner",
      telegramUserId: row.telegram_user_id, timezone: row.timezone, userId: input.userId,
    };
  },

  async facts(person: { familyId: string; telegramUserId: string; userId: string }): Promise<QuestFacts> {
    const [used, { rows }] = await Promise.all([
      featureUseRepository.used(person),
      database().query<{ adults: string; family_group: boolean; voice_task: boolean }>(
        `SELECT ${VOICE_TASK_SQL} AS voice_task,
                (SELECT count(*) FROM family_memberships AS membership
                  WHERE membership.family_id = $1 AND membership.relation IS DISTINCT FROM 'child')::text AS adults,
                EXISTS (SELECT 1 FROM telegram_groups AS grp WHERE grp.family_id = $1 AND grp.type = 'family_private') AS family_group`,
        [person.familyId, person.telegramUserId],
      ),
    ]);
    const row = rows[0]!;
    return { adults: Number(row.adults), familyGroup: row.family_group, used, voiceTask: row.voice_task };
  },

  /** Ставит отметки и возвращает только новые: отметка, поставленная раньше или соседним ходом, второй раз не считается. */
  async mark(person: { familyId: string; userId: string }, marks: readonly string[], now: Date): Promise<Set<string>> {
    if (marks.length === 0) return new Set();
    const { rows } = await database().query<{ mark: string }>(
      `INSERT INTO onboarding_quest_marks(family_id, user_id, mark, marked_at)
       SELECT $1, $2, mark, $4 FROM unnest($3::text[]) AS mark
       ON CONFLICT DO NOTHING RETURNING mark`,
      [person.familyId, person.userId, [...marks], now],
    );
    return new Set(rows.map((row) => row.mark));
  },

  /** Кому можно прислать касание: правило инициативы, подсказки не выключены, в знакомстве и без финала. */
  async recipients(now: Date): Promise<InitiativeRecipient[]> {
    const { rows } = await database().query<InitiativeRecipientRow>(
      initiativeRecipientQuery(`
          AND settings.feature_tips_enabled IS DISTINCT FROM false
          AND membership.created_at > $1::timestamptz - make_interval(days => $3)
          AND NOT EXISTS (SELECT 1 FROM onboarding_quest_marks AS quest
                           WHERE quest.user_id = person.id AND quest.mark = '${FINAL_MARK}')`),
      [now, INITIATIVE_DEFAULT_DAILY_LIMIT, QUEST_DAYS],
    );
    return rows.map(toInitiativeRecipient);
  },

  /** Заявка на день (вид `feature_tip`) и отметка касания одной транзакцией; null — сегодня уже писали или касание было. */
  async claimTouch(recipient: { familyId: string; userId: string }, localDate: string, day: number, now: Date): Promise<string | null> {
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
      const marked = deliveryRef === null ? null : await client.query(
        `INSERT INTO onboarding_quest_marks(family_id, user_id, mark, delivery_ref, marked_at)
         VALUES ($1, $2, $3, $4::uuid, $5) ON CONFLICT DO NOTHING RETURNING 1`,
        [recipient.familyId, recipient.userId, `touch_${day}`, deliveryRef, now],
      );
      if (deliveryRef === null || marked?.rowCount === 0) {
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

  /** True один раз на кнопку: второе нажатие или повтор обновления после сбоя подсказку не повторяют. */
  async spendButton(id: string, now: Date): Promise<boolean> {
    const result = await database().query(
      `UPDATE task_button_actions SET removed_at = $2
        WHERE id = $1 AND removed_at IS NULL AND replaced_by IS NULL`,
      [id, now],
    );
    return (result.rowCount ?? 0) === 1;
  },
};
