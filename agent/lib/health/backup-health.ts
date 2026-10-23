/**
 * Резервные копии в утреннем дайджесте.
 *
 * Экспорт:
 * - `BackupHealth`: последний прогон и последний успешный прогон из `backup_runs`.
 * - `readBackupHealth`: снимок на сейчас.
 * - `formatBackupHealth`: строка для дайджеста и признак сбоя, либо `null`, когда записей нет.
 *
 * Копию снимает `backup.py` на хосте, не агент, и до 9 октября 2026 о её судьбе знал только лог
 * cron, который никто не читал: после переезда на Fly копии уходили в бакет Яндекса, у которого
 * подряд шли инциденты. Теперь прогон пишет строку, и дайджест говорит три вещи: копия ушла во все
 * хранилища (справка), какое-то хранилище её не приняло (сбой), успешной копии нет дольше
 * `BACKUP_STALE_HOURS` (сбой: значит, упал сам прогон, до записи строки он не дошёл).
 * Пустая таблица молчит: установка без ночных копий или первая ночь после выпуска.
 */
import type { Pool } from "pg";

export const BACKUP_STALE_HOURS = 30;

export interface BackupRun {
  readonly bytes: number;
  readonly createdAt: Date;
  readonly failed: readonly string[];
  readonly stored: readonly string[];
}

export interface BackupHealth {
  readonly latest: BackupRun | null;
  readonly latestSuccessAt: Date | null;
}

const MOSCOW_TIME = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric", hour: "2-digit", minute: "2-digit", month: "long", timeZone: "Europe/Moscow",
});

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 2)} МБ`;
}

export function formatBackupHealth(health: BackupHealth, now: Date): { text: string; warning: boolean } | null {
  const { latest, latestSuccessAt } = health;
  if (latest === null) return null;
  const staleSince = latestSuccessAt ?? null;
  const ageHours = staleSince === null ? Infinity : (now.getTime() - staleSince.getTime()) / 3_600_000;
  if (ageHours > BACKUP_STALE_HOURS) {
    const last = staleSince === null ? "успешных копий нет" : `последняя успешная ${MOSCOW_TIME.format(staleSince)}`;
    return { text: `Копия: ${last}. Ночная копия не ушла: смотрите /opt/osinara/logs/backup.log.`, warning: true };
  }
  if (latest.failed.length > 0) {
    const reached = latest.stored.length === 0 ? "никуда не ушла" : `ушла только в ${latest.stored.join(", ")}`;
    return {
      text: `Копия ${MOSCOW_TIME.format(latest.createdAt)}: хранилище ${latest.failed.join(", ")} не приняло, ${reached}.`,
      warning: true,
    };
  }
  return { text: `Копия: ${MOSCOW_TIME.format(latest.createdAt)}, ${megabytes(latest.bytes)}, ${latest.stored.join(" и ")}.`, warning: false };
}

export async function readBackupHealth(client: Pick<Pool, "query">): Promise<BackupHealth> {
  const result = await client.query<{
    archive_bytes: string; created_at: Date; latest_success_at: Date | null; stores_failed: string[]; stores_ok: string[];
  }>(
    `SELECT run.archive_bytes::text, run.created_at, run.stores_ok, run.stores_failed,
            (SELECT max(created_at) FROM backup_runs WHERE cardinality(stores_ok) > 0) AS latest_success_at
       FROM backup_runs AS run ORDER BY run.created_at DESC, run.id DESC LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return { latest: null, latestSuccessAt: null };
  return {
    latest: { bytes: Number(row.archive_bytes), createdAt: row.created_at, failed: row.stores_failed, stored: row.stores_ok },
    latestSuccessAt: row.latest_success_at,
  };
}
