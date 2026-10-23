/**
 * External Telegram group policy projection from verified Eve auth.
 *
 * Exports:
 * - `resolveExternalGroupToolPolicy`: reads a fail-closed capability snapshot from session auth.
 * - `resolveExternalGroupPolicyIdentity`: reads the verified family/group policy key.
 *
 * This module holds no tool definitions, so prompt assembly can read the policy without importing
 * the whole executable tool surface.
 */
import type { SessionAuth } from "eve/context";

import { familylessGroupFromAuth } from "../familyless-group-auth.js";

import {
  parseExternalGroupToolAllowlist,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";

interface RestrictedGroupToolPolicy {
  allowed: ReadonlySet<ExternalGroupToolName>;
  restricted: true;
}

export type GroupToolPolicy = RestrictedGroupToolPolicy | { restricted: false };

function isExternalPrincipal(principal: SessionAuth["current"]): boolean {
  return principal?.attributes.groupType === "external";
}

function externalPolicyCaller(auth: SessionAuth): SessionAuth["current"] {
  const currentExternal = isExternalPrincipal(auth.current);
  const initiatorExternal = isExternalPrincipal(auth.initiator);
  if (!currentExternal && !initiatorExternal) return null;

  // An external initiator permanently taints a resumed session. A present current principal may
  // replace its policy only when it proves the same external trust zone; every conflict denies all.
  if (initiatorExternal && auth.current) {
    const sameGroup = auth.current.attributes.groupId === auth.initiator?.attributes.groupId;
    return currentExternal && sameGroup ? auth.current : null;
  }
  if (!auth.current && initiatorExternal) return auth.initiator;
  return auth.current;
}

export interface ExternalGroupPolicyIdentity {
  /** `null` for a group without a family (migration 175), whose turn carries no family attribute. */
  readonly familyId: string | null;
  readonly groupId: string;
}

export function resolveExternalGroupPolicyIdentity(auth: SessionAuth): ExternalGroupPolicyIdentity | null {
  const caller = externalPolicyCaller(auth);
  const attributes = caller?.attributes;
  const groupId = attributes?.groupId;
  if (typeof groupId !== "string" || groupId === "") return null;
  // One predicate decides «a group without a family» for the surface, prompt, database scope and billing.
  if (attributes !== undefined && !Object.hasOwn(attributes, "familyId")) {
    return familylessGroupFromAuth(attributes)?.groupId === groupId ? { familyId: null, groupId } : null;
  }
  const familyId = attributes?.familyId;
  return typeof familyId === "string" && familyId !== "" ? { familyId, groupId } : null;
}

export function resolveExternalGroupToolPolicy(auth: SessionAuth): GroupToolPolicy {
  const currentExternal = isExternalPrincipal(auth.current);
  const initiatorExternal = isExternalPrincipal(auth.initiator);
  if (!currentExternal && !initiatorExternal) return { restricted: false };

  const caller = externalPolicyCaller(auth);
  const allowed = caller ? parseExternalGroupToolAllowlist(caller.attributes.toolAllowlist) : null;

  // Corrupt or incomplete trusted policy must deny everything rather than widen the surface.
  return {
    allowed: allowed ?? new Set(),
    restricted: true,
  };
}
