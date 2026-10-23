/**
 * Who pressed a task button, and with what rights: read live, never from the button.
 *
 * Exports:
 * - `TaskButtonPress`: what Telegram says about the press.
 * - `TaskButtonAccess`: the presser's task authorization, or why the press is refused.
 * - `authorizeTaskButtonPress`: the decision; dependencies injected for tests.
 * - `privateChatAuthorization`: the rights of a person in their own private chat, shared with the Mini App.
 * - `productionTaskButtonAuthorizer`: the same decision on the application database.
 *
 * The row (`task-button-repository.ts`) says what the button was made for; it grants nothing. The
 * presser's identity comes only from `callback_query.from`, the chat only from the message the button
 * sits under, and both must match the row: a button forwarded to another chat or pressed by someone
 * else in a private chat is refused. In a group the access decision is the one a chat turn gets
 * (`evaluateConversationAccess`) on the live registration, so a former member or a person of another
 * family cannot press a button that is still visible to them.
 */
import type { PoolClient } from "pg";

import { database } from "../database.js";
import {
  evaluateConversationAccess,
  type FamilyIdentity,
  type RegisteredGroup,
} from "../family-access.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { resolveTurnSpaceContext } from "../spaces/turn-space-selection.js";
import { telegramRepository } from "../telegram-repository.js";
import type { TaskButtonRow } from "./task-button-repository.js";

export interface TaskButtonPress {
  chat: { id: string; type: "channel" | "group" | "private" | "supergroup" };
  presser: { id: string; isBot: boolean };
}

export type TaskButtonRefusal = "foreign_chat" | "not_for_you" | "not_member";

export type TaskButtonAccess =
  | { allowed: true; auth: MemoryAuthorization }
  | { allowed: false; reason: TaskButtonRefusal };

export interface TaskButtonAuthorizer {
  findGroup(chatId: string, chatType: "group" | "supergroup"): Promise<RegisteredGroup | null>;
  findIdentity(telegramUserId: string): Promise<FamilyIdentity | null>;
  /** The space a chat turn here would carry, with its policy version; null outside the spaces mode. */
  turnSpace(input: {
    familyId: string;
    groupId: string | null;
    userId: string;
  }): Promise<MemoryAuthorization["space"] | null>;
}

export async function authorizeTaskButtonPress(
  row: TaskButtonRow,
  press: TaskButtonPress,
  dependencies: TaskButtonAuthorizer,
): Promise<TaskButtonAccess> {
  if (press.chat.id !== row.chatId) return { allowed: false, reason: "foreign_chat" };
  if (row.recipientTelegramId !== null && row.recipientTelegramId !== press.presser.id) {
    return { allowed: false, reason: "not_for_you" };
  }
  if (press.presser.isBot || press.chat.type === "channel") return { allowed: false, reason: "not_member" };
  const identity = await dependencies.findIdentity(press.presser.id);
  if (!identity || identity.familyId !== row.familyId) return { allowed: false, reason: "not_member" };

  if (press.chat.type === "private") {
    // A private chat with the bot has the person's own id; anything else is not their chat.
    if (press.chat.id !== press.presser.id) return { allowed: false, reason: "foreign_chat" };
    return { allowed: true, auth: await privateChatAuthorization(identity, press.presser.id, dependencies) };
  }

  const group = await dependencies.findGroup(press.chat.id, press.chat.type);
  const decision = evaluateConversationAccess({
    actorKind: "telegram_user",
    chat: { id: press.chat.id, type: press.chat.type },
    identity,
    registeredGroup: group,
  });
  // Buttons are made only for family groups; an external group never acts on family tasks.
  if (!decision.allowed || group?.type !== "family_private" || decision.access.familyId !== row.familyId) {
    return { allowed: false, reason: "not_member" };
  }
  const space = await dependencies.turnSpace({
    familyId: identity.familyId,
    groupId: group.groupId,
    userId: identity.userId,
  });
  return {
    allowed: true,
    auth: {
      ...(space ? { space } : {}),
      familyId: identity.familyId,
      groupId: group.groupId,
      role: identity.role,
      scopes: ["family"],
      telegramActorId: press.presser.id,
      telegramActorKind: "telegram_user",
      telegramUserId: press.presser.id,
      userId: identity.userId,
    },
  };
}

/**
 * The rights a person has in their own private chat with the bot: what a private chat turn gets.
 * The Mini App (`web-app/web-app-api.ts`) uses the same, since it opens from that chat.
 */
export async function privateChatAuthorization(
  identity: FamilyIdentity,
  telegramUserId: string,
  dependencies: Pick<TaskButtonAuthorizer, "turnSpace">,
): Promise<MemoryAuthorization> {
  const space = await dependencies.turnSpace({ familyId: identity.familyId, groupId: null, userId: identity.userId });
  return {
    ...(space ? { space } : {}),
    familyId: identity.familyId,
    groupId: null,
    role: identity.role,
    scopes: ["personal", "family"],
    telegramActorId: telegramUserId,
    telegramActorKind: "telegram_user",
    telegramUserId,
    userId: identity.userId,
  };
}

async function spaceWithPolicy(
  client: PoolClient,
  input: { familyId: string; groupId: string | null; userId: string },
): Promise<MemoryAuthorization["space"] | null> {
  const context = await resolveTurnSpaceContext(client, {
    chatType: input.groupId === null ? "private" : "group",
    familyId: input.familyId,
    groupId: input.groupId,
    userId: input.userId,
  });
  if (!context) return null;
  const policy = await client.query<{ policy_version: string }>(
    "SELECT policy_version::text FROM spaces WHERE id = $1 AND family_id = $2 AND state = 'active'",
    [context.spaceId, input.familyId],
  );
  const version = Number(policy.rows[0]?.policy_version);
  return Number.isSafeInteger(version) && version > 0 ? { policyVersion: version, spaceId: context.spaceId } : null;
}

export const productionTaskButtonAuthorizer: TaskButtonAuthorizer = {
  findGroup: (chatId, chatType) => telegramRepository.findGroup(chatId, chatType),
  findIdentity: (telegramUserId) => telegramRepository.findIdentity(telegramUserId),
  async turnSpace(input) {
    const client = await database().connect();
    try {
      return await spaceWithPolicy(client, input);
    } finally {
      client.release();
    }
  },
};
