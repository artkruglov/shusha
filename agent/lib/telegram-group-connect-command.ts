/**
 * `/start@бот group` в группе: владелец семьи подключает обычную группу своей семьи («Группы», MVP-1).
 *
 * Exports:
 * - `parseGroupConnectCommand`: команда из ссылки `?startgroup=group`, голая или адресованная этому боту.
 * - `GROUP_CONNECT_TOOL_ALLOWLIST`: ровно те возможности, что получает такая группа.
 * - `registerGroupByCommand`: те же проверки, что у `/family` (владелец по базе, администратор по Telegram), и
 *   регистрация `external` с режимом `all`. Существующую группу не трогает: смена типа стёрла бы её данные.
 * - `GROUP_CONNECT_REPLIES`: что прочитает чат для каждого исхода.
 *
 * Семья в режиме пространств получает отказ `spaces`: регистрации нужна область владельца из лички (MVP).
 *
 * Разбор без модели, как у `/family`; включён только флагом `WEB_APP_GROUPS_ENABLED` (`groups-availability.ts`),
 * без флага команда идёт прежним путём группы без семьи. У такой группы своя область `group`: личного и
 * семейного она не видит (`family-access.ts`).
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { readFamilySpaceMode } from "./spaces/family-space-mode.js";
import { isOwnBotUsername } from "./telegram-bot-usernames.js";
import { verifyOwnerAdministrator } from "./telegram-family-group-command.js";
import type { TelegramGroupAdminVerifier } from "./telegram-group-admin-verification.js";
import { telegramGroupAdministrationRepository } from "./telegram-group-administration-repository.js";
import { cleanGroupTitle } from "./telegram-group-registration.js";
import { parseExternalGroupToolAllowlist } from "./tool-policy/group-tool-catalog.js";

const COMMAND_PATTERN = /^\/start(?:@(\w+))?\s+group$/u;

/** Дела, традиции и память самой группы; ничего, что выходит за её пределы. */
export const GROUP_CONNECT_TOOL_ALLOWLIST = ["manage_shared_tasks", "remember", "search_memories", "list_memories"] as const;

// Неизвестное имя в каталоге сделало бы всю политику группы недействительной: проверяется при загрузке.
if (parseExternalGroupToolAllowlist([...GROUP_CONNECT_TOOL_ALLOWLIST]) === null) {
  throw new AppError("AGENT_GROUP_CONNECT_ALLOWLIST_INVALID", "Возможности подключаемой группы не совпадают с каталогом");
}

export type GroupConnectCommandResult = "registered" | "already" | "not_admin" | "admin_check_failed" | "not_owner" | "other_family" | "other_type" | "familyless" | "spaces";

export function parseGroupConnectCommand(text: string, botUsername: string): boolean {
  const match = COMMAND_PATTERN.exec(text.trim());
  if (!match) return false;
  // Команда другому боту в той же группе не наша.
  return match[1] === undefined || isOwnBotUsername(match[1], botUsername);
}

export async function registerGroupByCommand(input: {
  telegramChatId: string;
  telegramUserId: string;
  title: string;
  verifier?: TelegramGroupAdminVerifier;
}): Promise<GroupConnectCommandResult> {
  const owner = await verifyOwnerAdministrator(input);
  if (typeof owner === "string") return owner;
  // В режиме пространств регистрация требует области владельца из лички, которой у команды в группе нет;
  // для MVP такая семья подключает группы прежним путём.
  if (await familySpaceMode(owner.familyId) !== "legacy") return "spaces";
  // Создание под блокировкой чата в `registerGroup`; уже существующая строка не меняется и не пересоздаётся.
  try {
    await telegramGroupAdministrationRepository.registerGroup({
      createOnly: true,
      familyId: owner.familyId,
      messageMode: "all",
      requestedBy: owner.userId,
      telegramChatId: input.telegramChatId,
      title: cleanGroupTitle(input.title, "Группа"),
      toolAllowlist: [...GROUP_CONNECT_TOOL_ALLOWLIST],
      type: "external",
    });
  } catch (error) {
    if (error instanceof AppError &&
      (error.code === "AGENT_GROUP_REGISTRATION_CONFLICT" || error.code === "AGENT_GROUP_ALREADY_REGISTERED")) {
      return await existingGroupResult(input.telegramChatId, owner.familyId);
    }
    // Режим включили между проверкой и регистрацией.
    if (error instanceof AppError && error.code === "AGENT_SPACE_CONTEXT_REQUIRED") return "spaces";
    throw error;
  }
  console.info(JSON.stringify({ code: "AGENT_GROUP_CONNECTED_BY_COMMAND", familyId: owner.familyId }));
  return "registered";
}

async function familySpaceMode(familyId: string) {
  const client = await database().connect();
  try {
    return await readFamilySpaceMode(client, familyId);
  } finally {
    client.release();
  }
}

/** Группа уже есть: своя обычная это `already`, своя семейная `other_type`, чужая или без семьи отдельно. */
async function existingGroupResult(telegramChatId: string, familyId: string): Promise<GroupConnectCommandResult> {
  const existing = await database().query<{ family_id: string | null; type: string }>(
    "SELECT family_id, type FROM telegram_groups WHERE telegram_chat_id = $1",
    [telegramChatId],
  );
  const current = existing.rows[0];
  // Строка исчезла между отказом и чтением: повторная команда разберётся заново.
  if (!current) return "admin_check_failed";
  if (current.family_id === null) return "familyless";
  if (current.family_id !== familyId) return "other_family";
  return current.type === "external" ? "already" : "other_type";
}

export const GROUP_CONNECT_REPLIES: Record<GroupConnectCommandResult, string> = {
  admin_check_failed: "Telegram не дал проверить ваши права в этой группе. Убедитесь, что бот состоит в группе, и повторите позже.",
  already: "Эта группа уже подключена.",
  familyless: "Здесь я включена без семьи. Чтобы подключить группу к семье, выключите меня командой /stop и добавьте снова по ссылке из приложения.",
  not_admin: "Подключить группу может только её создатель или администратор в Telegram. Назначьте себя администратором и повторите.",
  not_owner: "Подключить группу может только владелец семьи.",
  other_family: "Эта группа уже принадлежит другой семье.",
  other_type: "Эта группа уже подключена как семейная.",
  spaces: "В этой семье группы пока подключаются через личный чат с владельцем.",
  registered: "Группа подключена: у неё свои дела, традиции и память. Личного и семейного она не видит. Сделайте меня администратором, если ещё нет.",
};
