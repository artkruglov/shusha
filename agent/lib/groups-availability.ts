/**
 * «Группы» (MVP-1): флаг и ссылка, которой владелец добавляет бота в новую группу.
 *
 * Exports:
 * - `groupsEnabled`, `WEB_APP_GROUPS_ENABLED`: включены ли группы; только при `WEB_APP_GROUPS_ENABLED=true` ровно.
 * - `GROUP_START_PAYLOAD`: слово ссылки `?startgroup=`, которое приходит в группу как `/start@бот group`.
 * - `groupCreateLink`: ссылка «Создать группу» для владельца, или null при неверном имени бота.
 * - `familyChatLink`: ссылка, которой семейный чат подключается сразу с правами администратора.
 *
 * Выключенный флаг возвращает всё как было: команда уходит по прежнему пути, маршруты Mini App отвечают 404.
 * Флаг читается при загрузке модуля, как остальные признаки доступности (`grocery-config.ts`).
 */
export function groupsEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.WEB_APP_GROUPS_ENABLED === "true";
}

export const WEB_APP_GROUPS_ENABLED = groupsEnabled();

export const GROUP_START_PAYLOAD = "group";

/** Права администратора, которые Telegram предложит выдать боту в той же форме добавления. */
const ADMIN_RIGHTS = "change_info+delete_messages+invite_users+pin_messages";

/** Семейный чат: те же права в форме добавления, иначе владелец потом ищет, где сделать бота администратором. */
export function familyChatLink(botUsername: string | undefined): string | null {
  if (!botUsername || !/^[A-Za-z0-9_]{5,32}$/u.test(botUsername)) return null;
  return `https://t.me/${botUsername}?startgroup=family&admin=${ADMIN_RIGHTS}`;
}

export function groupCreateLink(botUsername: string | undefined): string | null {
  if (!botUsername || !/^[A-Za-z0-9_]{5,32}$/u.test(botUsername)) return null;
  return `https://t.me/${botUsername}?startgroup=${GROUP_START_PAYLOAD}&admin=${ADMIN_RIGHTS}`;
}
