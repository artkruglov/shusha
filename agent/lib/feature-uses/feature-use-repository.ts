/**
 * Что человек уже попробовал: записи хука и признаки из уже лежащих данных.
 *
 * Экспорт:
 * - `FEATURE_CHAT_MESSAGES`: сколько своих сообщений в личке значит «просто разговаривает».
 * - `featureUseRepository`: `record` пишет ключи хода (`feature-use-signals.ts`), `used` отдаёт всё попробованное.
 *
 * Хук видит только вызовы инструментов. Фото, голосовое и документ модель получает без инструмента, просьба другому
 * это обычное дело с чужим исполнителем, гостевой режим живёт вне сессии Eve, а Google подключают ссылкой. Их `used`
 * считает при выборе совета из того, что и так хранится: сырые обновления личного чата (30 дней, потом их удаляет
 * `telegram-ingress-retention.ts`), дела, счётчик гостевых ответов, подключения и напоминания. Новых записей ради
 * этого нет: старое фото, о котором забыли, просто снова делает совет о фото возможным, и это не ошибка.
 */
import { database } from "../database.js";
import { withFamilyDatabaseContext } from "../database-context.js";
import { FEATURE_KEYS, type FeatureKey } from "./feature-catalog.js";

export const FEATURE_CHAT_MESSAGES = 10;

/** Обновление — сообщение этого человека в его личном чате с ботом. */
const OWN_PRIVATE_MESSAGE = `update_row.payload->'message'->'from'->>'id' = $3
  AND update_row.payload->'message'->'chat'->>'type' = 'private'`;

const USED_SQL = `
SELECT feature FROM feature_uses WHERE user_id = $1 AND family_id = $2
UNION SELECT 'photo' WHERE EXISTS (SELECT 1 FROM telegram_ingress_updates AS update_row
  WHERE ${OWN_PRIVATE_MESSAGE} AND update_row.payload->'message' ? 'photo')
UNION SELECT 'voice' WHERE EXISTS (SELECT 1 FROM telegram_ingress_updates AS update_row
  WHERE ${OWN_PRIVATE_MESSAGE} AND update_row.voice_file_id IS NOT NULL)
UNION SELECT 'document' WHERE EXISTS (SELECT 1 FROM telegram_ingress_updates AS update_row
  WHERE ${OWN_PRIVATE_MESSAGE} AND update_row.payload->'message' ? 'document')
UNION SELECT 'chat' WHERE (SELECT count(*) FROM (SELECT 1 FROM telegram_ingress_updates AS update_row
  WHERE ${OWN_PRIVATE_MESSAGE} LIMIT $4) AS own) >= $4
UNION SELECT 'request' WHERE EXISTS (SELECT 1 FROM shared_tasks AS task
  WHERE task.family_id = $2 AND task.creator_telegram_id = $3
    AND task.assignee_telegram_id IS NOT NULL AND task.assignee_telegram_id <> task.creator_telegram_id)
UNION SELECT 'guest' WHERE EXISTS (SELECT 1 FROM telegram_guest_usage AS guest WHERE guest.telegram_user_id::text = $3)
UNION SELECT 'google' WHERE EXISTS (SELECT 1 FROM integration_accounts AS account
  WHERE account.connected_by_user_id = $1 AND account.family_id = $2 AND account.status = 'active')
UNION SELECT 'reminder' WHERE EXISTS (SELECT 1 FROM reminders AS reminder WHERE reminder.author_user_id = $1)`;

const KNOWN: ReadonlySet<string> = new Set(FEATURE_KEYS);

export const featureUseRepository = {
  /** Один ход это одно использование каждого ключа; человек должен быть в этой семье и сейчас. */
  async record(input: { familyId: string; features: readonly FeatureKey[]; now: Date; userId: string }): Promise<void> {
    if (input.features.length === 0) return;
    await withFamilyDatabaseContext(input.familyId, () => database().query(
      `INSERT INTO feature_uses(family_id, user_id, feature, first_used_at, last_used_at, uses)
       SELECT $1, $2, feature, $4, $4, 1
         FROM unnest($3::text[]) AS feature
        WHERE EXISTS (SELECT 1 FROM family_memberships AS membership
                       WHERE membership.family_id = $1 AND membership.user_id = $2)
       ON CONFLICT (user_id, feature) DO UPDATE
         SET uses = feature_uses.uses + 1,
             last_used_at = GREATEST(feature_uses.last_used_at, EXCLUDED.last_used_at)`,
      [input.familyId, input.userId, [...input.features], input.now],
    ));
  },

  async used(person: { familyId: string; telegramUserId: string; userId: string }): Promise<Set<FeatureKey>> {
    const { rows } = await database().query<{ feature: string }>(USED_SQL, [
      person.userId, person.familyId, person.telegramUserId, FEATURE_CHAT_MESSAGES,
    ]);
    return new Set(rows.map((row) => row.feature).filter((feature): feature is FeatureKey => KNOWN.has(feature)));
  },
};
