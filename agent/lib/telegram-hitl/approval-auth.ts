/**
 * Current database authorization for resumed Telegram HITL turns.
 *
 * Exports:
 * - `ApprovalAuthRow`: approval/session fields required to rebuild trusted Eve auth.
 * - `resolveCurrentApprovalAuth`: revalidates identity, membership, group, and scopes.
 * - `retainTurnAttributes`: the context of the requesting turn that the approval row keeps.
 *
 * The turn resumed after a tap gets freshly read policy (role, scopes, group) but, without the
 * requesting turn's context, no sandbox session, no visible timeline entries and no turn start:
 * memory sources could not bind (`turn_attributes_invalid` on every such turn) and browser tools had
 * no container. The approval row keeps that context and the resume restores it UNDER the fresh
 * policy; nothing that authorizes is ever taken from the row (upstream nyxandro 84d04ee).
 */
import type { SessionAuthContext } from "eve/context";
import type { PoolClient } from "pg";

import { authorizeSpaceAction } from "../spaces/space-access.js";
import { isAppError } from "../app-error.js";

type TelegramChatType = "group" | "private" | "supergroup";
type MemoryScope = "family" | "group" | "personal";
type FamilyRole = "member" | "owner" | "recovery_owner";
type GroupType = "external" | "family_private";

export interface ApprovalAuthRow {
  application_session_id: string;
  space_id?: string | null;
  space_policy_version?: number | null;
  eve_session_id: string;
  expected_telegram_user_id: string;
  family_id: string;
  group_id: string | null;
  owner_user_id: string | null;
  scope: MemoryScope;
  telegram_chat_id: string;
  telegram_chat_type: TelegramChatType;
  telegram_conversation_id?: string | null;
  telegram_message_id: string;
  telegram_message_thread_id: string | null;
  telegram_timeline_entry_id?: string | null;
  /** The session's current sandbox thread; the resumed turn works in the same container. */
  thread_id?: string | null;
  /** The requesting turn's context (`retainTurnAttributes`), restored under fresh policy. */
  turn_attributes?: unknown;
}

/**
 * Context of the requesting turn that the resumed turn needs and that carries no authorization:
 * where the sandbox is, which message and timeline position the turn answers, what it saw.
 * Policy attributes (role, scopes, group, allowlist, identity) are never taken from here.
 */
export const RETAINED_TURN_ATTRIBUTES = [
  "memoryReviewBatchId", "memoryReviewMode", "memoryReviewSourceEntryIds", "proactiveDeliveryCursor", "sandboxSessionId",
  "telegramConversationId", "telegramForumTopicId", "telegramMessageThreadId", "telegramProfileMentionUserIds",
  "telegramProfileReplyTimelineSequence", "telegramProfileReplyUserId", "telegramReplyToMessageId", "telegramTimelineEntryId",
  "telegramTimelineOmittedBeforeSequence", "telegramTimelineSequence", "telegramTimelineVisibleEntryIds", "telegramTurnStartedAt",
] as const;

export function retainTurnAttributes(attributes: Record<string, unknown> | undefined): Record<string, unknown> {
  const retained: Record<string, unknown> = {};
  for (const key of RETAINED_TURN_ATTRIBUTES) {
    const value = attributes?.[key];
    if (value !== undefined) retained[key] = value;
  }
  return retained;
}

function restoredTurnAttributes(row: ApprovalAuthRow): Record<string, unknown> {
  const stored = row.turn_attributes && typeof row.turn_attributes === "object" && !Array.isArray(row.turn_attributes)
    ? retainTurnAttributes(row.turn_attributes as Record<string, unknown>)
    : {};
  return {
    ...(row.thread_id ? { sandboxSessionId: row.thread_id } : {}),
    ...stored,
  };
}

interface IdentityRow {
  family_id: string;
  role: FamilyRole;
  user_id: string;
}

interface GroupRow {
  family_id: string;
  id: string;
  message_mode: "addressed_only" | "all" | "owner_only";
  tool_allowlist: string[];
  type: GroupType;
}

async function findIdentity(client: PoolClient, telegramUserId: string, familyId: string): Promise<IdentityRow | null> {
  const result = await client.query<IdentityRow>(
    `SELECT fm.family_id, fm.role, fm.user_id
       FROM users u
       JOIN family_memberships fm ON fm.user_id = u.id
      WHERE u.telegram_user_id = $1
        AND fm.family_id = $2`,
    [telegramUserId, familyId],
  );
  return result.rows[0] ?? null;
}

export async function resolveCurrentApprovalAuth(client: PoolClient, row: ApprovalAuthRow): Promise<SessionAuthContext | null> {
  const identity = await findIdentity(client, row.expected_telegram_user_id, row.family_id);
  let group: GroupRow | null = null;
  let memoryScopes: MemoryScope[];
  let role: FamilyRole | "external";
  let userId: string | null;

  // Personal approvals remain bound to the current session owner and active family membership.
  if (row.scope === "personal") {
    if (!identity || identity.user_id !== row.owner_user_id || identity.family_id !== row.family_id || row.telegram_chat_type !== "private") return null;
    memoryScopes = ["personal", "family"];
    role = identity.role;
    userId = identity.user_id;
  } else {
    const groupResult = await client.query<GroupRow>(
      `SELECT id, family_id, type, message_mode, tool_allowlist
         FROM telegram_groups
        WHERE id = $1 AND telegram_chat_id = $2`,
      [row.group_id, row.telegram_chat_id],
    );
    group = groupResult.rows[0] ?? null;
    if (!group || group.family_id !== row.family_id || row.telegram_chat_type === "private") return null;

    // Family groups require current membership; external groups retain identity only for members.
    const familyIdentity = identity?.family_id === group.family_id ? identity : null;
    if (group.type === "family_private") {
      if (!familyIdentity || row.scope !== "family") return null;
      memoryScopes = ["family"];
      role = familyIdentity.role;
      userId = familyIdentity.user_id;
    } else {
      if (row.scope !== "group") return null;
      // A parked approval cannot outlive owner-role revocation in an owner-only external group.
      if (group.message_mode === "owner_only" && familyIdentity?.role !== "owner") return null;
      memoryScopes = ["group"];
      role = familyIdentity?.role ?? "external";
      userId = familyIdentity?.user_id ?? null;
    }
  }

  // Прежняя история несёт space_id от бэкфилла без версии политики, и её область не проверяется:
  // такая строка возможна только до включения режима. Ворота перехода не пускают включение, пока
  // жива хоть одна сессия, а каждая созданная после него несёт версию.
  if (row.space_policy_version != null) {
    if (!row.space_id) return null;
    try {
      await authorizeSpaceAction(client, { familyId: row.family_id, userId, spaceId: row.space_id,
        policyVersion: row.space_policy_version,
        chat: row.telegram_chat_type === "private" ? { type: "private" }
          : { type: row.telegram_chat_type, groupId: row.group_id! },
      }, "read");
    } catch (error) {
      if (isAppError(error) && ["AGENT_SPACE_ACCESS_DENIED", "AGENT_SPACE_CONTEXT_STALE"].includes(error.code)) return null;
      throw error;
    }
  }
  // The requesting turn's context comes first; only freshly read database policy may follow it.
  return {
    attributes: {
      ...restoredTurnAttributes(row),
      applicationSessionId: row.application_session_id,
      ...(row.space_policy_version != null
        ? { spaceId: row.space_id!, spacePolicyVersion: String(row.space_policy_version) }
        : {}),
      familyId: row.family_id,
      memoryScopes,
      role,
      telegramChatId: row.telegram_chat_id,
      telegramChatType: row.telegram_chat_type,
      telegramMessageId: row.telegram_message_id,
      telegramActorId: row.expected_telegram_user_id,
      telegramActorKind: "telegram_user",
      ...(row.telegram_message_thread_id === null ? {} : { telegramMessageThreadId: row.telegram_message_thread_id }),
      // The resumed turn corrects memory and moves threads against the message that started it.
      ...(row.telegram_conversation_id ? { telegramConversationId: row.telegram_conversation_id } : {}),
      ...(row.telegram_timeline_entry_id ? { telegramTimelineEntryId: row.telegram_timeline_entry_id } : {}),
      telegramUserId: row.expected_telegram_user_id,
      ...(group ? { groupId: group.id, groupType: group.type } : {}),
      ...(group && group.type !== "family_private" ? { toolAllowlist: group.tool_allowlist } : {}),
    },
    authenticator: "telegram",
    principalId: userId ?? `telegram:${row.expected_telegram_user_id}`,
    principalType: "user",
  };
}
