/**
 * `/family` в группе: владелец одной командой делает группу семейной.
 *
 * Exports:
 * - `FAMILY_GROUP_COMMAND_PATTERN`: команда `/family` с необязательным `@бот`.
 * - `registerFamilyGroupByCommand`: проверяет владельца по базе и регистрирует группу как `family_private`
 *   в режиме `all`. Чужую группу и группу другого типа не трогает: смена типа стёрла бы её данные.
 * - `verifyOwnerAdministrator`: владелец семьи по базе и живой администратор группы по Telegram.
 */
import { TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED } from "../config.js";
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { isBannedFromFamily, lockFamilyMembers } from "./family-repository.js";
import { telegramGroupAdminVerifier, type TelegramGroupAdminVerifier } from "./telegram-group-admin-verification.js";
import { provisionMemberPersonalSpace } from "./spaces/space-provisioning.js";
import { cleanGroupTitle } from "./telegram-group-registration.js";
import { telegramGroupAdministrationRepository } from "./telegram-group-administration-repository.js";

// `/family` подключает группу, `/family on|off` включает и выключает автоподключение; `/start@бот family`
// приходит из ссылки `?startgroup=family`, когда владелец добавляет бота в группу кнопкой.
export const FAMILY_GROUP_COMMAND_PATTERN = /^(?:\/family(?:@\w+)?(?:\s+(on|off))?|\/start(?:@\w+)?\s+family)$/u;

export type FamilyGroupCommandResult = "registered" | "auto_on" | "auto_off" | "not_admin" | "admin_check_failed" | "already" | "not_connected" | "not_owner" | "other_family" | "other_type" | "familyless";

export async function registerFamilyGroupByCommand(input: {
  autoJoin?: "on" | "off";
  telegramChatId: string;
  telegramUserId: string;
  title: string;
  verifier?: TelegramGroupAdminVerifier;
}): Promise<FamilyGroupCommandResult> {
  const owner = await verifyOwnerAdministrator(input);
  if (typeof owner === "string") return owner;
  const row = { family_id: owner.familyId, user_id: owner.userId };
  if (input.autoJoin) return await switchAutoJoin(input.telegramChatId, row.family_id, input.autoJoin === "on");
  // Создание и включение автовхода одним шагом внутри блокировки чата; существующая группа не пересоздаётся
  // и не меняется, даже если другая регистрация успела между проверкой и вставкой.
  try {
    await telegramGroupAdministrationRepository.registerGroup({
      autoJoinMembers: true,
      createOnly: true,
      familyId: row.family_id,
      messageMode: "all",
      requestedBy: row.user_id,
      telegramChatId: input.telegramChatId,
      title: cleanGroupTitle(input.title, "Семейная группа"),
      toolAllowlist: [],
      type: "family_private",
    });
  } catch (error) {
    // Чужая семья или группа без семьи: ответ различает их по самой строке.
    if (error instanceof AppError && error.code === "AGENT_GROUP_REGISTRATION_CONFLICT") {
      return await existingGroupResult(input.telegramChatId, row.family_id);
    }
    if (error instanceof AppError && error.code === "AGENT_GROUP_ALREADY_REGISTERED") {
      return await existingGroupResult(input.telegramChatId, row.family_id);
    }
    throw error;
  }
  return "registered";
}

/**
 * Владелец семьи по базе и живой администратор этой группы по Telegram: общая проверка `/family` и
 * `/start@бот group` (`telegram-group-connect-command.ts`). Возвращает семью владельца или причину отказа.
 */
export async function verifyOwnerAdministrator(input: {
  telegramChatId: string;
  telegramUserId: string;
  verifier?: TelegramGroupAdminVerifier;
}): Promise<{ familyId: string; userId: string } | "admin_check_failed" | "not_admin" | "not_owner"> {
  const owner = await database().query<{ family_id: string; user_id: string }>(
    `SELECT m.family_id, m.user_id
       FROM users u JOIN family_memberships m ON m.user_id = u.id AND m.role = 'owner'
      WHERE u.telegram_user_id = $1`,
    [input.telegramUserId],
  );
  const row = owner.rows[0];
  if (!row) return "not_owner";
  // Владелец какой-то семьи в чужой группе не должен превращать её в зону своей семьи: Telegram
  // обязан подтвердить, что он создатель или администратор именно этой группы.
  try {
    await (input.verifier ?? telegramGroupAdminVerifier).requireAdministrator({
      telegramChatId: input.telegramChatId,
      telegramUserId: input.telegramUserId,
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "AGENT_TELEGRAM_GROUP_OWNER_NOT_ADMIN") return "not_admin";
    if (error instanceof AppError) return "admin_check_failed";
    throw error;
  }
  return { familyId: row.family_id, userId: row.user_id };
}

/** Что ответить, когда группа уже есть: своя семейная это `already`, чужая или внешняя нет. */
async function existingGroupResult(telegramChatId: string, familyId: string): Promise<FamilyGroupCommandResult> {
  const existing = await database().query<{ family_id: string | null; type: string }>(
    "SELECT family_id, type FROM telegram_groups WHERE telegram_chat_id = $1",
    [telegramChatId],
  );
  const current = existing.rows[0];
  if (!current) return "not_connected";
  if (current.family_id === null) return "familyless";
  if (current.family_id !== familyId) return "other_family";
  return current.type === "family_private" ? "already" : "other_type";
}

/** `/family on|off` под той же блокировкой чата, что и регистрация: переключатель не затирается и не опережает её. */
async function switchAutoJoin(telegramChatId: string, familyId: string, enabled: boolean): Promise<FamilyGroupCommandResult> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED]);
    const updated = await client.query(
      `UPDATE telegram_groups SET auto_join_members = $3
        WHERE telegram_chat_id = $1 AND family_id = $2 AND type = 'family_private'`,
      [telegramChatId, familyId, enabled],
    );
    await client.query("COMMIT");
    if (updated.rowCount) return enabled ? "auto_on" : "auto_off";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return await existingGroupResult(telegramChatId, familyId);
}

/**
 * Человек без семьи пишет в группе, подключённой командой `/family`: он входит в её семью участником.
 * Владелец группы решил, кто в ней, значит впустил; человек уже в другой семье не входит никуда.
 * Возвращает владельца для уведомления или null, если входа не было.
 */
export async function autoJoinFamilyGroupMember(input: {
  displayName: string;
  telegramChatId: string;
  telegramUserId: string;
  username?: string;
}): Promise<{ ownerTelegramUserId: string } | null> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const group = await client.query<{ family_id: string; owner_telegram_user_id: string }>(
      `SELECT g.family_id, u.telegram_user_id::text AS owner_telegram_user_id
         FROM telegram_groups g
         JOIN family_memberships m ON m.family_id = g.family_id AND m.role = 'owner'
         JOIN users u ON u.id = m.user_id
        WHERE g.telegram_chat_id = $1 AND g.type = 'family_private' AND g.auto_join_members
        ORDER BY m.created_at LIMIT 1`,
      [input.telegramChatId],
    );
    const row = group.rows[0];
    if (!row) { await client.query("ROLLBACK"); return null; }
    // Состав семьи меняется под одним замком; убранного владельцем автовход не возвращает.
    await lockFamilyMembers(client, row.family_id);
    if (await isBannedFromFamily(client, row.family_id, input.telegramUserId)) {
      await client.query("ROLLBACK");
      return null;
    }
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, display_name, telegram_username) VALUES ($1, $2, $3)
       ON CONFLICT (telegram_user_id) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [input.telegramUserId, input.displayName, input.username ?? null],
    );
    const membership = await client.query(
      `INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
      [row.family_id, user.rows[0]!.id],
    );
    if (!membership.rowCount) { await client.query("ROLLBACK"); return null; }
    await provisionMemberPersonalSpace(client, { familyId: row.family_id, userId: user.rows[0]!.id });
    await client.query(
      `INSERT INTO audit_events (family_id, actor_user_id, event_type, metadata)
       VALUES ($1, $2, 'group.member_auto_joined', jsonb_build_object('telegramUserId', $3::text))`,
      [row.family_id, user.rows[0]!.id, input.telegramUserId],
    );
    await client.query("COMMIT");
    return { ownerTelegramUserId: row.owner_telegram_user_id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const FAMILY_GROUP_REPLIES: Record<FamilyGroupCommandResult, string> = {
  admin_check_failed: "Telegram не дал проверить ваши права в этой группе. Убедитесь, что бот состоит в группе, и повторите позже.",
  not_admin: "Подключить группу может только её создатель или администратор в Telegram. Назначьте себя администратором и повторите.",
  not_connected: "Эта группа ещё не подключена к семье. Напишите здесь /family.",
  auto_off: "Автоподключение выключено: новые люди сами в семью не входят, приглашайте их ссылкой.",
  auto_on: "Автоподключение включено: человек без семьи, написавший здесь, входит в вашу семью.",
  familyless: "Здесь я включена без семьи. Чтобы сделать группу семейной, выключите меня командой /stop и напишите /family.",
  already: "Эта группа уже подключена к вашей семье.",
  not_owner: "Подключить группу к семье может только владелец семьи.",
  other_family: "Эта группа уже принадлежит другой семье.",
  other_type: "Эта группа подключена как внешняя. Чтобы сделать её семейной, напишите мне в личку.",
  registered: "Группа подключена как семейная: я слушаю её и записываю дела, отвечаю на обращения. Кто напишет здесь и ещё не состоит ни в одной семье, войдёт в вашу, а вы получите уведомление. Отключить: /family off.",
};
