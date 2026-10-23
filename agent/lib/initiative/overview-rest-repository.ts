/**
 * Показы дел в утреннем обзоре и дела, которые человек решил оставить (миграция 190).
 *
 * Экспорт:
 * - `OVERVIEW_SHOWS_BEFORE_REST`: сколько утр подряд дело без изменений показывается в обзоре.
 * - `OverviewRest`: какие из дел обзор больше не повторяет.
 * - `overviewRestRepository`: чтение, запись показов и «Оставить».
 *
 * 21 октября 2026: четыре просроченных дела стояли в обзоре по 26–31 утру, «✓» под ними не нажали
 * ни разу. Владелец решил, что обзор не должен констатировать просрочку: после трёх показов без
 * изменений дело уходит из обзора, а вместо повтора приходит одно сообщение с помощью
 * (`stale-task-dispatch.ts`). Счёт идёт по версии дела: любая правка начинает его заново, а
 * «Оставить» держит дело в стороне до следующей правки.
 */
import { database } from "../database.js";

export const OVERVIEW_SHOWS_BEFORE_REST = 3;
/** Показы старше этого срока ничего не решают и удаляются при записи новых. */
const SHOWS_KEPT_DAYS = 60;

export interface OverviewRest {
  /**
   * О деле на нынешней версии уже ушло сообщение о давнем деле: обзор его больше не повторяет. Не число показов:
   * иначе дело пропадало из обзора и тогда, когда сообщение не ушло (предел инициатив, личное время; ревью
   * 21 октября 2026).
   */
  readonly repeated: ReadonlySet<string>;
  /** Человек нажал «Оставить» на нынешней версии. */
  readonly rested: ReadonlySet<string>;
}

interface Versioned {
  readonly id: string;
  readonly version: number;
}

export const overviewRestRepository = {
  async read(userId: string, tasks: readonly Versioned[]): Promise<OverviewRest> {
    if (tasks.length === 0) return { repeated: new Set(), rested: new Set() };
    const { rows } = await database().query<{ id: string; repeated: boolean; rested: boolean }>(
      `SELECT task.id,
              EXISTS (SELECT 1 FROM stale_task_claims AS claim
                WHERE claim.user_id = $1 AND claim.task_id = task.id AND claim.task_version = task.version) AS repeated,
              EXISTS (SELECT 1 FROM task_overview_rests AS rest
                WHERE rest.user_id = $1 AND rest.task_id = task.id AND rest.task_version = task.version) AS rested
         FROM unnest($2::uuid[], $3::int[]) AS task(id, version)`,
      [userId, tasks.map((task) => task.id), tasks.map((task) => task.version)],
    );
    return {
      repeated: new Set(rows.filter((row) => row.repeated).map((row) => row.id)),
      rested: new Set(rows.filter((row) => row.rested).map((row) => row.id)),
    };
  },

  /**
   * Обзор ушёл: показанные строками просроченные дела получают показ этого дня (повтор того же дня ничего не меняет).
   * Сегодняшние не считаются: дело, которое пять дней стояло в плане, не должно стать давним в первое же утро просрочки.
   */
  async recordShows(input: { familyId: string; shownOn: string; tasks: readonly Versioned[]; userId: string }): Promise<void> {
    if (input.tasks.length === 0) return;
    await database().query(
      `WITH shown AS (
         INSERT INTO task_overview_shows(family_id, user_id, task_id, task_version, shown_on)
         SELECT $1, $2, task.id, task.version, $5::date FROM unnest($3::uuid[], $4::int[]) AS task(id, version)
         ON CONFLICT DO NOTHING RETURNING 1)
       DELETE FROM task_overview_shows WHERE user_id = $2 AND shown_on < $5::date - $6::int`,
      [input.familyId, input.userId, input.tasks.map((task) => task.id), input.tasks.map((task) => task.version),
        input.shownOn, SHOWS_KEPT_DAYS],
    );
  },

  /** «Оставить»: дело не появляется в обзоре и не зовёт помощь, пока его не изменят. */
  async rest(input: { familyId: string; taskId: string; taskVersion: number; userId: string }): Promise<void> {
    await database().query(
      `INSERT INTO task_overview_rests(family_id, user_id, task_id, task_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, task_id) DO UPDATE SET task_version = excluded.task_version, created_at = now()`,
      [input.familyId, input.userId, input.taskId, input.taskVersion],
    );
  },
};
