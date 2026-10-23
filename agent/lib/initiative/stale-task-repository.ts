/**
 * Данные сообщения о давнем деле: кому, о каком деле и один раз в сутки (миграции 190–192).
 *
 * Экспорт:
 * - `StaleTaskRecipient`: человек с личной сессией и его правило инициативы.
 * - `staleTaskRepository`: адресаты, дело-кандидат и заявка.
 *
 * Кандидат — просроченное принятое дело человека, которое утренний обзор показал три утра подряд на
 * одной версии (`overview-rest-repository.ts`): так в выборку попадает только то, что человек и так
 * видел, и только в той области, где он его видел. Дело, оставленное кнопкой «Оставить», и дело, о
 * котором на этой версии уже писали, не кандидаты. Самое давнее идёт первым.
 */
import { database } from "../database.js";
import {
  INITIATIVE_DEFAULT_DAILY_LIMIT,
  initiativeRecipientQuery,
  toInitiativeRecipient,
  type InitiativeRecipient,
  type InitiativeRecipientRow,
} from "./initiative-audience.js";
import { OVERVIEW_SHOWS_BEFORE_REST } from "./overview-rest-repository.js";
import type { StaleTask } from "./stale-task.js";

export type StaleTaskRecipient = InitiativeRecipient;

const CANDIDATE_SQL = `
SELECT task.id, task.title, task.version,
       to_char((task.updated_at AT TIME ZONE $5), 'YYYY-MM-DD') AS since
  FROM shared_tasks AS task
 WHERE task.family_id = $2 AND task.kind = 'task' AND task.status = 'accepted'
   AND task.assignee_telegram_id = $3
   -- Повторяющееся дело это серия в одной строке: «Снять» отменило бы всю серию.
   AND task.recurrence_unit IS NULL
   AND (task.due_at < $4::timestamptz OR task.due_on < ($4::timestamptz AT TIME ZONE $5)::date)
   AND (SELECT count(*) FROM task_overview_shows AS show
         WHERE show.user_id = $1 AND show.task_id = task.id AND show.task_version = task.version) >= $6
   AND NOT EXISTS (SELECT 1 FROM task_overview_rests AS rest
         WHERE rest.user_id = $1 AND rest.task_id = task.id AND rest.task_version = task.version)
   AND NOT EXISTS (SELECT 1 FROM stale_task_claims AS claim
         WHERE claim.user_id = $1 AND claim.task_id = task.id AND claim.task_version = task.version)
 ORDER BY task.updated_at, task.id
 LIMIT 1`;

export const staleTaskRepository = {
  async recipients(now: Date): Promise<StaleTaskRecipient[]> {
    const { rows } = await database().query<InitiativeRecipientRow>(
      initiativeRecipientQuery(),
      [now, INITIATIVE_DEFAULT_DAILY_LIMIT],
    );
    return rows.map(toInitiativeRecipient);
  },

  async candidate(recipient: StaleTaskRecipient, now: Date): Promise<StaleTask | null> {
    const { rows } = await database().query<{ id: string; since: string; title: string; version: number }>(CANDIDATE_SQL, [
      recipient.userId, recipient.familyId, recipient.telegramUserId, now, recipient.settings.timezone,
      OVERVIEW_SHOWS_BEFORE_REST,
    ]);
    const row = rows[0];
    return row ? { id: row.id, since: row.since, title: row.title, version: row.version } : null;
  },

  /** Заявка на сутки и отметка о деле одной транзакцией: отправленное сообщение не придёт о нём ещё раз. */
  async claim(recipient: StaleTaskRecipient, localDate: string, task: StaleTask, now: Date): Promise<string | null> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ delivery_ref: string }>(
        `INSERT INTO initiative_messages(family_id, user_id, kind, sent_on, sent_at)
         VALUES ($1, $2, 'stale_task', $3::date, $4)
         ON CONFLICT DO NOTHING RETURNING delivery_ref`,
        [recipient.familyId, recipient.userId, localDate, now],
      );
      const deliveryRef = inserted.rows[0]?.delivery_ref ?? null;
      if (deliveryRef === null) {
        await client.query("ROLLBACK");
        return null;
      }
      const claimed = await client.query(
        `INSERT INTO stale_task_claims(family_id, user_id, task_id, task_version, delivery_ref, claimed_at)
         VALUES ($1, $2, $3, $4, $5::uuid, $6) ON CONFLICT DO NOTHING RETURNING 1`,
        [recipient.familyId, recipient.userId, task.id, task.version, deliveryRef, now],
      );
      // Две встречные заявки о той же версии (тики на стыке суток): пишет только первая.
      if (claimed.rowCount === 0) {
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
};
