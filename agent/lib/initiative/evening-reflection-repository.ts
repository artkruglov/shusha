/**
 * Данные итога дня: кому, что было за день и заявка на сутки (миграции 195–196).
 *
 * Экспорт:
 * - `EveningReflectionRecipient`: человек с личной сессией и его правило инициативы.
 * - `eveningReflectionRepository`: адресаты, содержание дня и заявка.
 *
 * Итог включён по умолчанию (`evening_reflection_enabled` NULL); выпадает только нажавший «Не писать вечером».
 * Открытое и проекты читает тот же обзор, что собирает утро, с той же авторизацией человека: чужого личного он не
 * покажет. Закрытое сегодня считается по событиям выполнения, которые совершил сам человек, только в личной и
 * семейной областях: дело внешней или обычной группы в личный чат не переносится.
 */
import { database } from "../database.js";
import { dailyOverviewRepository } from "./daily-overview-repository.js";
import { eveningReflectionInput, type EveningReflectionInput } from "./evening-reflection.js";
import {
  INITIATIVE_DEFAULT_DAILY_LIMIT,
  initiativeRecipientQuery,
  toInitiativeRecipient,
  type InitiativeRecipient,
  type InitiativeRecipientRow,
} from "./initiative-audience.js";

export type EveningReflectionRecipient = InitiativeRecipient;

const CLOSED_TODAY_SQL = `
SELECT title FROM (
  SELECT DISTINCT ON (task.id) task.title, version.created_at
    FROM shared_task_versions AS version
    JOIN shared_tasks AS task ON task.id = version.task_id
   WHERE task.family_id = $1 AND task.kind = 'task' AND version.action = 'complete'
     AND version.actor_telegram_id = $2
     AND task.scope IN ('personal', 'family')
     AND (task.scope <> 'personal' OR task.assignee_telegram_id = $2)
     -- Повтор после выполнения снова открыт со следующей датой; обычное дело считается, только если и сейчас закрыто.
     AND (task.recurrence_unit IS NOT NULL OR task.status = 'completed')
     AND version.created_at >= ($3::date::timestamp AT TIME ZONE $4)
     AND version.created_at <= $5::timestamptz
   ORDER BY task.id, version.created_at DESC
) AS closed
ORDER BY created_at, title`;

export const eveningReflectionRepository = {
  async recipients(now: Date): Promise<EveningReflectionRecipient[]> {
    const { rows } = await database().query<InitiativeRecipientRow>(
      initiativeRecipientQuery("AND settings.evening_reflection_enabled IS DISTINCT FROM false"),
      [now, INITIATIVE_DEFAULT_DAILY_LIMIT],
    );
    return rows.map(toInitiativeRecipient);
  },

  async content(recipient: EveningReflectionRecipient, localDate: string, now: Date): Promise<EveningReflectionInput> {
    const overview = await dailyOverviewRepository.overview(recipient);
    const closed = await database().query<{ title: string }>(CLOSED_TODAY_SQL, [
      recipient.familyId, recipient.telegramUserId, localDate, recipient.settings.timezone, now,
    ]);
    const before = await database().query<{ sent: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM initiative_messages WHERE user_id = $1 AND kind = 'evening_reflection') AS sent",
      [recipient.userId],
    );
    return eveningReflectionInput(
      { ...overview, now }, closed.rows.map((row) => row.title), before.rows[0]?.sent !== true,
    );
  },

  /** Заявка на сутки по уникальному индексу (миграция 196); назад не отдаётся, как у обзора. */
  async claim(recipient: EveningReflectionRecipient, localDate: string, now: Date): Promise<string | null> {
    const inserted = await database().query<{ delivery_ref: string }>(
      `INSERT INTO initiative_messages(family_id, user_id, kind, sent_on, sent_at)
       VALUES ($1, $2, 'evening_reflection', $3::date, $4)
       ON CONFLICT DO NOTHING RETURNING delivery_ref`,
      [recipient.familyId, recipient.userId, localDate, now],
    );
    return inserted.rows[0]?.delivery_ref ?? null;
  },
};
