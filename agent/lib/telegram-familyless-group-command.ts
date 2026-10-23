/**
 * `/start` and `/stop` in a group without a family: its Telegram administrator turns the bot on and off.
 *
 * Exports:
 * - `parseFamilylessGroupCommand`: `/start` (with an optional link parameter) or `/stop`, bare or
 *   addressed to this bot by `@username`.
 * - `runFamilylessGroupCommand`: checks the sender is the group's creator or administrator in
 *   Telegram, then enables or erases the group; returns the reply for the chat, or null for a repeat
 *   inside the cooldown.
 * - `FAMILYLESS_GROUP_REPLIES`: what the chat reads for each outcome.
 * - `FAMILYLESS_GROUP_BUDGET_NOTICE`: the one message a month when the group's budget is used up.
 *
 * Key constructs:
 * - Telegram is the only authority here (owner's decision 15 October 2026): no family, word or
 *   operator approval stands behind such a group, so every command asks `getChatMember` live.
 * - `/start@бот family` stays the family command; a family's group never reaches this module.
 * - `/stop` erases the group, its conversation, journal and audit at once. Service copies go by their
 *   own clocks: the retired session within a day, raw updates in 30 days, spend numbers in 40.
 * - A command is checked with Telegram at most once per sender and chat in `COMMAND_COOLDOWN_MS`;
 *   repeats inside it are ignored silently, so nobody can turn the chat into a stream of API calls.
 */
import { AppError } from "./app-error.js";
import {
  familylessGroupRepository,
  type FamilylessGroupDisableResult,
  type FamilylessGroupEnableResult,
} from "./familyless-group-repository.js";
import { isOwnBotUsername } from "./telegram-bot-usernames.js";
import { telegramGroupAdminVerifier, type TelegramGroupAdminVerifier } from "./telegram-group-admin-verification.js";

// The "add to group" link (`?startgroup=<word>`) sends `/start@бот <word>`; `family` is caught earlier
// by the family command and an invitation code is dropped before this point.
const COMMAND_PATTERN = /^\/(?:(start)(?:@(\w+))?(?:\s+[\w-]{1,64})?|(stop)(?:@(\w+))?)$/u;

export type FamilylessGroupCommand = "start" | "stop";

const COMMAND_COOLDOWN_MS = 30_000;
const COOLDOWN_ENTRIES_MAX = 1_000;
// Per process: each worker limits its own share, which bounds the total by the number of workers.
const lastCommandAt = new Map<string, number>();

/** True when this sender already ran a command in this chat within the cooldown. */
function coolingDown(key: string, now: number): boolean {
  const last = lastCommandAt.get(key);
  if (last !== undefined && now - last < COMMAND_COOLDOWN_MS) return true;
  if (lastCommandAt.size >= COOLDOWN_ENTRIES_MAX) {
    for (const [entry, at] of lastCommandAt) if (now - at >= COMMAND_COOLDOWN_MS) lastCommandAt.delete(entry);
    if (lastCommandAt.size >= COOLDOWN_ENTRIES_MAX) return true;
  }
  lastCommandAt.set(key, now);
  return false;
}

export function parseFamilylessGroupCommand(text: string, botUsername: string): FamilylessGroupCommand | null {
  const match = COMMAND_PATTERN.exec(text.trim());
  if (!match) return null;
  // A command addressed to another bot in the same group is not ours to answer.
  const target = match[2] ?? match[4];
  if (target !== undefined && !isOwnBotUsername(target, botUsername)) return null;
  return match[1] === "start" ? "start" : "stop";
}

type Outcome =
  | FamilylessGroupEnableResult
  | Exclude<FamilylessGroupDisableResult, "taken">
  | "admin_check_failed"
  | "not_admin";

export const FAMILYLESS_GROUP_REPLIES: Record<Outcome, string> = {
  absent: "Я здесь и так выключена.",
  admin_check_failed: "Telegram не дал проверить ваши права в этой группе. Повторите чуть позже.",
  already: "Я уже включена в этой группе. Зовите меня по имени или через @, выключить: /stop.",
  disabled: "Выключила и удалила историю и данные этой группы; служебные копии сотрутся сами в течение месяца. Включить снова: /start.",
  enabled: "Включилась. Зовите меня по имени, через @ или ответом на моё сообщение: отвечу и поищу в интернете. " +
    "Памяти, напоминаний и файлов в этой группе пока нет. Выключить и стереть всё: /stop.",
  full: "Сейчас подключить меня к новой группе нельзя: свободных мест нет. Попробуйте позже.",
  not_admin: "Включать и выключать меня здесь может только создатель или администратор группы.",
  taken: "Эта группа подключена к семье, ею управляет владелец семьи.",
};

export const FAMILYLESS_GROUP_BUDGET_NOTICE =
  "В этом месяце бюджет этой группы исчерпан, поэтому до 1-го числа я здесь молчу.";

export async function runFamilylessGroupCommand(input: {
  command: FamilylessGroupCommand;
  telegramChatId: string;
  telegramChatType: "group" | "supergroup";
  telegramUserId: string;
  title: string;
  now?: number;
  repository?: typeof familylessGroupRepository;
  verifier?: TelegramGroupAdminVerifier;
}): Promise<string | null> {
  if (coolingDown(`${input.telegramChatId}:${input.telegramUserId}`, input.now ?? Date.now())) return null;
  try {
    await (input.verifier ?? telegramGroupAdminVerifier).requireAdministrator({
      telegramChatId: input.telegramChatId,
      telegramUserId: input.telegramUserId,
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "AGENT_TELEGRAM_GROUP_OWNER_NOT_ADMIN") {
      return FAMILYLESS_GROUP_REPLIES.not_admin;
    }
    if (error instanceof AppError) return FAMILYLESS_GROUP_REPLIES.admin_check_failed;
    throw error;
  }
  const repository = input.repository ?? familylessGroupRepository;
  const result = input.command === "start"
    ? await repository.enable({
        enabledByTelegramUserId: input.telegramUserId,
        telegramChatId: input.telegramChatId,
        telegramChatType: input.telegramChatType,
        title: input.title,
      })
    : await repository.disable({ telegramChatId: input.telegramChatId });
  console.info(JSON.stringify({
    chatId: input.telegramChatId,
    code: "AGENT_FAMILYLESS_GROUP_COMMAND",
    command: input.command,
    result,
  }));
  return FAMILYLESS_GROUP_REPLIES[result];
}
