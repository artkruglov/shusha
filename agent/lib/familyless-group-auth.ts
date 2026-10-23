/**
 * A turn of a group without a family (migration 175), recognised from verified session auth.
 *
 * Export:
 * - `familylessGroupFromAuth`: the group and its Telegram chat, or null for every other turn.
 *
 * Key construct:
 * - Such a turn carries no `familyId` attribute at all (`telegram-turn-result.ts`); an attribute that
 *   is present but broken is a family turn gone wrong and is never read as one without a family.
 */
import { isDatabaseFamilyId } from "./database-context.js";

const TELEGRAM_CHAT_ID = /^-?[0-9]{1,20}$/u;

export function familylessGroupFromAuth(
  attributes: Readonly<Record<string, unknown>> | null | undefined,
): { groupId: string; telegramChatId: string } | null {
  if (!attributes || Object.hasOwn(attributes, "familyId") || attributes.groupType !== "external") return null;
  const { groupId, telegramChatId } = attributes;
  if (!isDatabaseFamilyId(groupId) || typeof telegramChatId !== "string" || !TELEGRAM_CHAT_ID.test(telegramChatId)) {
    return null;
  }
  return { groupId, telegramChatId };
}
