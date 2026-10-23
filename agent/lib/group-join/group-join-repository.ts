/**
 * Что заявкам в группу нужно из базы: обычная группа семьи с её владельцем и участие человека в семье.
 *
 * Exports:
 * - `JoinGroup`: группа, в которую просятся, и кто решает за неё.
 * - `groupJoinRepository`: живые чтения без снимков; фон ходит системным контекстом, поэтому каждый запрос
 *   сам ограничен группой и семьёй.
 * - `greet`, `take`, `release`: строка приглашения (миграция 188). Каждое решение сначала забирает строку одним
 *   запросом и только потом идёт в Telegram: нажатие без приветствия, повтор и второе нажатие не делают ничего.
 */
import { database } from "../database.js";

/** Строки, которые никто не решил, живут столько же, сколько бот готов помнить заявку. */
const FORGOTTEN_AFTER_DAYS = 30;

export interface JoinGroup {
  readonly familyId: string;
  readonly groupId: string;
  readonly ownerName: string;
  readonly ownerTelegramUserId: string;
  readonly telegramChatId: string;
  readonly title: string;
}

export const groupJoinRepository = {
  /** Только обычная группа семьи (`external` с семьёй): семейную, группу без семьи и чужие чаты заявки не трогают. */
  async findGroup(telegramChatId: string): Promise<JoinGroup | null> {
    const result = await database().query<{
      family_id: string; id: string; owner_name: string; owner_telegram_user_id: string; title: string;
    }>(
      `SELECT g.id, g.family_id, g.title, u.display_name AS owner_name, u.telegram_user_id::text AS owner_telegram_user_id
         FROM telegram_groups g
         JOIN family_memberships m ON m.family_id = g.family_id AND m.role = 'owner'
         JOIN users u ON u.id = m.user_id
        WHERE g.telegram_chat_id = $1 AND g.type = 'external' AND g.family_id IS NOT NULL
        ORDER BY m.created_at LIMIT 1`,
      [telegramChatId],
    );
    const row = result.rows[0];
    return row ? {
      familyId: row.family_id, groupId: row.id, ownerName: row.owner_name,
      ownerTelegramUserId: row.owner_telegram_user_id, telegramChatId, title: row.title,
    } : null;
  },

  /** Участник семьи сейчас и не в списке исключённых. */
  async isFamilyMember(familyId: string, telegramUserId: string): Promise<boolean> {
    const result = await database().query(
      `SELECT 1 FROM users u JOIN family_memberships m ON m.user_id = u.id AND m.family_id = $1
        WHERE u.telegram_user_id = $2
          AND NOT EXISTS (SELECT 1 FROM family_member_bans b WHERE b.family_id = $1 AND b.telegram_user_id = $2)`,
      [familyId, telegramUserId],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /** Приветствие уходит: строка «встречен» (повторная заявка начинает заново), заодно чистка забытых. */
  async greet(group: JoinGroup, telegramUserId: string): Promise<void> {
    await database().query(
      "DELETE FROM group_join_invitations WHERE created_at < now() - make_interval(days => $1)", [FORGOTTEN_AFTER_DAYS]);
    await database().query(
      `INSERT INTO group_join_invitations(family_id, group_id, telegram_user_id, status) VALUES($1, $2, $3, 'greeted')
       ON CONFLICT (group_id, telegram_user_id) DO UPDATE SET status = 'greeted', created_at = now()`,
      [group.familyId, group.groupId, telegramUserId]);
  },

  /**
   * Забирает строку в состоянии `from`: `to` её переводит (`asked`), null удаляет. False, если такой строки нет:
   * приветствия не было, решение уже принято или нажатие повторное.
   */
  async take(groupId: string, telegramUserId: string, from: "greeted" | "asked", to: "asked" | null): Promise<boolean> {
    const result = to === null
      ? await database().query(
        "DELETE FROM group_join_invitations WHERE group_id = $1 AND telegram_user_id = $2 AND status = $3",
        [groupId, telegramUserId, from])
      : await database().query(
        "UPDATE group_join_invitations SET status = $4 WHERE group_id = $1 AND telegram_user_id = $2 AND status = $3",
        [groupId, telegramUserId, from, to]);
    return (result.rowCount ?? 0) > 0;
  },

  /** Вопрос владельцу не ушёл: человек может нажать «Вступить» ещё раз. */
  async release(groupId: string, telegramUserId: string): Promise<void> {
    await database().query(
      "UPDATE group_join_invitations SET status = 'greeted' WHERE group_id = $1 AND telegram_user_id = $2 AND status = 'asked'",
      [groupId, telegramUserId]);
  },

  /** Приветствие не дошло (человек закрыл личку для бота): строки нет, кнопок нет. */
  async forget(groupId: string, telegramUserId: string): Promise<void> {
    await database().query(
      "DELETE FROM group_join_invitations WHERE group_id = $1 AND telegram_user_id = $2", [groupId, telegramUserId]);
  },
};
