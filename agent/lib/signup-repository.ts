/**
 * Саморегистрация семей: настройки входа и создание семьи по общей ссылке.
 *
 * Exports:
 * - `signupRepository`: настройки (`status`, `update`), проверка оператора и `claimSelfServeFamily`.
 * - `SIGNUP_WORD_PATTERN`: допустимое слово ссылки.
 *
 * Ключевые решения:
 * - Вход по умолчанию закрыт; открывает и закрывает оператор, то есть владелец самой ранней семьи установки.
 * - Слово ссылки не должно совпадать по длине с кодами владельца (43 знака) и приглашения (32 знака): граница регистрации
 *   различает эти коды по длине.
 * - Строка настроек блокируется на время создания семьи, поэтому потолок числа семей не обходится двумя одновременными Start.
 */
import { timingSafeEqual } from "node:crypto";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { withSystemDatabaseContext } from "./database-context.js";
import { createFamilyWithOwner } from "./telegram-repository.js";

export const SIGNUP_WORD_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const WAITLIST_LIMIT = 500;
// Позванные за последние сутки и ещё не вошедшие держат место за собой.
const RESERVED_SLOTS_SQL = `(
  SELECT count(*) FROM signup_waitlist x
   WHERE x.notified_at > now() - interval '24 hours'
     AND NOT EXISTS (SELECT 1 FROM users u JOIN family_memberships m ON m.user_id = u.id WHERE u.telegram_user_id = x.telegram_user_id)
)`;
const RESERVED_WORD_LENGTHS = new Set([32, 43]);

export interface SignupStatus {
  readonly families: number;
  readonly waiting: number;
  readonly isOpen: boolean;
  readonly maxFamilies: number;
  readonly word: string | null;
}

export interface SignupProfile {
  readonly displayName: string;
  readonly telegramUserId: string;
  readonly username?: string;
}

export type SignupClaim = "claimed" | "closed" | "configured" | "full" | "invalid";

export function validateSignupWord(word: string): void {
  if (!SIGNUP_WORD_PATTERN.test(word) || RESERVED_WORD_LENGTHS.has(word.length)) {
    throw new AppError(
      "AGENT_SIGNUP_WORD_INVALID",
      "Слово ссылки: латинские буквы, цифры, _ и -, до 64 знаков, но не 32 и не 43 знака",
    );
  }
}

function sameWord(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const signupRepository = {
  async status(): Promise<SignupStatus> {
    const result = await database().query<{ families: string; waiting: string; is_open: boolean; max_families: number; word: string | null }>(
      `SELECT s.is_open, s.word, s.max_families, (SELECT count(*) FROM families)::text AS families,
              (SELECT count(*) FROM signup_waitlist WHERE notified_at IS NULL)::text AS waiting
         FROM signup_settings s`,
    );
    const row = result.rows[0];
    return {
      families: Number(row?.families ?? 0),
      waiting: Number(row?.waiting ?? 0),
      isOpen: row?.is_open ?? false,
      maxFamilies: row?.max_families ?? 0,
      word: row?.word ?? null,
    };
  },

  async update(patch: { isOpen: boolean; maxFamilies?: number; word?: string | null }): Promise<SignupStatus> {
    if (patch.word) validateSignupWord(patch.word);
    if (patch.maxFamilies !== undefined && (!Number.isInteger(patch.maxFamilies) || patch.maxFamilies < 0)) {
      throw new AppError("AGENT_SIGNUP_LIMIT_INVALID", "Число семей должно быть целым неотрицательным");
    }
    await database().query(
      `UPDATE signup_settings
          SET is_open = $1,
              max_families = COALESCE($2, max_families),
              word = CASE WHEN $3::boolean THEN $4 ELSE word END,
              updated_at = now()`,
      [patch.isOpen, patch.maxFamilies ?? null, patch.word !== undefined, patch.word ?? null],
    );
    return await this.status();
  },

  /** Кому ответили «мест нет»: запоминаем один раз, очередь ограничена, чтобы её нельзя было раздуть бесконечно. */
  /** True when the person is new on the list: the operator hears about each person once, not about every repeat. */
  async joinWaitlist(profile: SignupProfile): Promise<boolean> {
    const result = await database().query<{ inserted: boolean }>(
      `INSERT INTO signup_waitlist (telegram_user_id, display_name)
       SELECT $1, $2 WHERE (SELECT count(*) FROM signup_waitlist) < $3
       ON CONFLICT (telegram_user_id) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             -- Позванный и ещё не вошедший сохраняет резерв и очередь: повторный /start при полном наборе их не сбрасывает.
             notified_at = CASE WHEN signup_waitlist.notified_at > now() - interval '24 hours' THEN signup_waitlist.notified_at ELSE NULL END
       RETURNING (xmax = 0) AS inserted`,
      [profile.telegramUserId, profile.displayName, WAITLIST_LIMIT],
    );
    return result.rows[0]?.inserted === true;
  },

  /** Telegram id of the operator (the owner of the earliest family), who decides who comes in next. */
  async operatorTelegramUserId(): Promise<string | null> {
    const result = await withSystemDatabaseContext(() => database().query<{ id: string }>(
      `SELECT u.telegram_user_id AS id FROM families f
         JOIN family_memberships m ON m.family_id = f.id AND m.role = 'owner'
         JOIN users u ON u.id = m.user_id
       ORDER BY f.created_at, f.id LIMIT 1`,
    ));
    return result.rows[0]?.id ?? null;
  },

  /**
   * Первые по очереди, которым хватает свободных мест: помечаются уведомлёнными здесь же и под тем же замком строки настроек,
   * что и вход семьи, поэтому два вызова не резервируют места сверх свободных, а повторный вызов никого не вернёт второй раз.
   * Возвращает и слово ссылки, по которому им надо входить. Пустой список при закрытом входе и без мест.
   */
  async takeWaitlistBatch(): Promise<{ ids: string[]; word: string | null }> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const settings = await client.query<{ is_open: boolean; max_families: number; word: string | null }>(
        "SELECT is_open, max_families, word FROM signup_settings FOR UPDATE",
      );
      const row = settings.rows[0];
      if (!row?.is_open) {
        await client.query("COMMIT");
        return { ids: [], word: null };
      }
      const free = await client.query<{ slots: number }>(
        `SELECT GREATEST($1::int - (SELECT count(*) FROM families) - ${RESERVED_SLOTS_SQL}, 0)::int AS slots`,
        [row.max_families],
      );
      const picked = await client.query<{ telegram_user_id: string }>(
        `UPDATE signup_waitlist w SET notified_at = now()
          WHERE w.telegram_user_id IN (
            SELECT telegram_user_id FROM signup_waitlist
             WHERE notified_at IS NULL ORDER BY created_at LIMIT $1::int)
          RETURNING w.telegram_user_id`,
        [free.rows[0]?.slots ?? 0],
      );
      await client.query("COMMIT");
      return { ids: picked.rows.map((item) => item.telegram_user_id), word: row.word };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /** Сообщение не дошло: человек возвращается в очередь, его резерв не держится зря. */
  async releaseWaitlistNotice(telegramUserId: string): Promise<void> {
    await database().query("UPDATE signup_waitlist SET notified_at = NULL WHERE telegram_user_id = $1", [telegramUserId]);
  },

  /** Оператор установки: владелец самой ранней семьи. Только он управляет входом. */
  async isOperatorFamily(familyId: string): Promise<boolean> {
    const result = await withSystemDatabaseContext(() => database().query<{ id: string }>(
      "SELECT id FROM families ORDER BY created_at, id LIMIT 1",
    ));
    return result.rows[0]?.id === familyId;
  },

  async claimSelfServeFamily(payload: string | null, profile: SignupProfile): Promise<SignupClaim> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const settings = await client.query<{ is_open: boolean; max_families: number; word: string | null }>(
        "SELECT is_open, word, max_families FROM signup_settings FOR UPDATE",
      );
      const row = settings.rows[0];
      if (!row?.is_open) {
        await client.query("ROLLBACK");
        return "closed";
      }
      // Слово задано: ссылка обязана его нести. Слова нет: годится любая ссылка и просто Start.
      if (row.word !== null && (payload === null || !sameWord(payload, row.word))) {
        await client.query("ROLLBACK");
        return "invalid";
      }
      const known = await client.query(
        `SELECT 1 FROM users u JOIN family_memberships m ON m.user_id = u.id WHERE u.telegram_user_id = $1`,
        [profile.telegramUserId],
      );
      if (known.rowCount) {
        await client.query("ROLLBACK");
        return "configured";
      }
      // Чужой резерв места занять нельзя; позванный сам входит по своему резерву.
      const families = await client.query<{ n: string }>(
        `SELECT (count(*) + (
           SELECT count(*) FROM signup_waitlist x
            WHERE x.notified_at > now() - interval '24 hours' AND x.telegram_user_id <> $1
              AND NOT EXISTS (SELECT 1 FROM users u JOIN family_memberships m ON m.user_id = u.id WHERE u.telegram_user_id = x.telegram_user_id)
         ))::text AS n FROM families`,
        [profile.telegramUserId],
      );
      if (Number(families.rows[0]?.n ?? 0) >= row.max_families) {
        await client.query("ROLLBACK");
        return "full";
      }
      await createFamilyWithOwner(client, profile);
      await client.query("COMMIT");
      return "claimed";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
