/**
 * Trusted family and group access policy.
 *
 * Exports:
 * - `FamilyRole`: authenticated family roles.
 * - `TelegramGroupMessageMode`: persisted group collection modes.
 * - `RegisteredGroup`: persisted Telegram group policy.
 * - `ConversationAccess`: scopes exposed to Eve runtime code.
 * - `FamilyConversationAccess`, `hasFamilyAccess`: access that belongs to a family (every chat but a
 *   group without one).
 * - `evaluateConversationAccess`: returns an explicit allow/deny decision.
 * - `resolveConversationAccess`: rejects unknown callers before model execution.
 */
import { AppError } from "./app-error.js";
import type { TelegramActorKind } from "./telegram-inbound-actor.js";

export type FamilyRole = "member" | "owner" | "recovery_owner";
export type RegisteredGroupType = "external" | "family_private";
export type TelegramGroupMessageMode = "addressed_only" | "all" | "owner_only";
export type StandardTelegramGroupMessageMode = Exclude<TelegramGroupMessageMode, "owner_only">;

export interface FamilyIdentity {
  familyId: string;
  role: FamilyRole;
  userId: string;
}

interface RegisteredGroupBase {
  groupId: string;
  telegramChatId: string;
  toolAllowlist: string[];
}

/** A group a family registered; the only kind before migration 175. */
export type FamilyGroup = RegisteredGroupBase & { familyId: string } & (
  | {
    messageMode: StandardTelegramGroupMessageMode;
    type: "family_private";
  }
  | {
    messageMode: TelegramGroupMessageMode;
    type: "external";
  }
);

/** A group its Telegram administrator turned on without any family (migration 175): always external. */
export type FamilylessGroup = RegisteredGroupBase & {
  familyId: null;
  messageMode: TelegramGroupMessageMode;
  type: "external";
};

export type RegisteredGroup = FamilyGroup | FamilylessGroup;

export interface ConversationAccess {
  /** `null` only in a group without a family (migration 175): scope `group`, role `external`. */
  familyId: string | null;
  groupId: string | null;
  memoryScopes: Array<"family" | "group" | "personal">;
  role: FamilyRole | "external";
  userId: string | null;
}

export type FamilyConversationAccess = ConversationAccess & { familyId: string };

export function hasFamilyAccess(access: ConversationAccess): access is FamilyConversationAccess {
  return access.familyId !== null;
}

export interface ResolveConversationAccessInput {
  actorKind: TelegramActorKind;
  chat: {
    id: string;
    type: "group" | "private" | "supergroup";
  };
  identity: FamilyIdentity | null;
  registeredGroup: RegisteredGroup | null;
}

export type ConversationAccessDecision =
  | { access: ConversationAccess; allowed: true }
  | { allowed: false; error: AppError };

export function evaluateConversationAccess(
  input: ResolveConversationAccessInput,
): ConversationAccessDecision {
  // Private chats require a registered family identity and expose only that caller's scopes.
  if (input.chat.type === "private") {
    if (input.actorKind !== "telegram_user" || !input.identity) {
      return {
        allowed: false,
        error: new AppError(
          "AGENT_ACCESS_DENIED",
          "У вас нет доступа к этому семейному агенту. Попросите владельца отправить приглашение",
        ),
      };
    }

    return {
      access: {
        familyId: input.identity.familyId,
        groupId: null,
        memoryScopes: ["personal", "family"],
        role: input.identity.role,
        userId: input.identity.userId,
      },
      allowed: true,
    };
  }

  // Group identity comes only from a persisted registration, never from model-visible text.
  const group = input.registeredGroup;
  if (!group || group.telegramChatId !== input.chat.id) {
    return {
      allowed: false,
      error: new AppError("AGENT_GROUP_NOT_REGISTERED", "Эта группа не подключена к агенту"),
    };
  }

  // A family group is private to active members of the same family.
  if (group.type === "family_private") {
    if (input.actorKind !== "telegram_user" || !input.identity ||
      input.identity.familyId !== group.familyId) {
      return {
        allowed: false,
        error: new AppError(
          "AGENT_ACCESS_DENIED",
          "У вас нет доступа к семейной памяти этой группы",
        ),
      };
    }

    return {
      access: {
        familyId: group.familyId,
        groupId: group.groupId,
        memoryScopes: ["family"],
        role: input.identity.role,
        userId: input.identity.userId,
      },
      allowed: true,
    };
  }

  // A group its Telegram administrator turned on has no family: nobody in it carries a family
  // identity, whoever writes, so a family member there is as external as anyone else.
  if (group.familyId === null) {
    return {
      access: { familyId: null, groupId: group.groupId, memoryScopes: ["group"], role: "external", userId: null },
      allowed: true,
    };
  }

  // A channel proves only its visible Telegram chat identity. It can participate in an external
  // group, but can never inherit the human owner behind that channel or satisfy owner-only mode.
  if (input.actorKind === "telegram_channel" && group.messageMode === "owner_only") {
    return {
      allowed: false,
      error: new AppError(
        "AGENT_TELEGRAM_CHANNEL_OWNER_REQUIRED",
        "Сообщения от имени канала недоступны в режиме только для владельца",
      ),
    };
  }

  // Another bot is a visible participant, never a person: it cannot stand in for the owner.
  if (input.actorKind === "telegram_bot" && group.messageMode === "owner_only") {
    return {
      allowed: false,
      error: new AppError(
        "AGENT_TELEGRAM_BOT_OWNER_REQUIRED",
        "Сообщения от другого бота недоступны в режиме только для владельца",
      ),
    };
  }

  // External groups remain group-only, but a same-family identity is retained for owner administration.
  const familyIdentity = input.actorKind === "telegram_user" &&
    input.identity?.familyId === group.familyId ? input.identity : null;
  return {
    access: {
      familyId: group.familyId,
      groupId: group.groupId,
      memoryScopes: ["group"],
      role: familyIdentity?.role ?? "external",
      userId: familyIdentity?.userId ?? null,
    },
    allowed: true,
  };
}

export function resolveConversationAccess(input: ResolveConversationAccessInput): ConversationAccess {
  const decision = evaluateConversationAccess(input);
  if (!decision.allowed) throw decision.error;
  return decision.access;
}
