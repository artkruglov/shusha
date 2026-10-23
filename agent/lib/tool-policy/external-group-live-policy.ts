/**
 * Current external-group capability policy.
 *
 * Export:
 * - `loadCurrentExternalGroupCapabilities`: reads and validates the current PostgreSQL allowlist.
 * - `authorizeCurrentExternalGroupCapability`: records the execution-time authorization boundary.
 * - `FAMILYLESS_GROUP_TOOL_NAMES`: the most a group without a family may ever be granted.
 *
 * A group without a family (migration 175) is matched by `family_id IS NULL`, and its grant is cut
 * to web search and fetch whatever its allowlist says: memory, files, skills, images and tasks all
 * live with a family, and their gates read this same policy.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  parseExternalGroupToolAllowlist,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";
import type { ExternalGroupPolicyIdentity } from "./external-group-policy.js";

export const FAMILYLESS_GROUP_TOOL_NAMES: ReadonlySet<ExternalGroupToolName> = new Set(["web_fetch", "web_search"]);

function capForGroup(
  allowed: ReadonlySet<ExternalGroupToolName>,
  input: ExternalGroupPolicyIdentity,
): ReadonlySet<ExternalGroupToolName> {
  return input.familyId === null
    ? new Set([...allowed].filter((name) => FAMILYLESS_GROUP_TOOL_NAMES.has(name)))
    : allowed;
}

export async function loadCurrentExternalGroupCapabilities(
  input: ExternalGroupPolicyIdentity,
): Promise<ReadonlySet<ExternalGroupToolName>> {
  const result = await database().query<{ tool_allowlist: string[] }>(
    `SELECT tool_allowlist
       FROM telegram_groups
      WHERE id = $1
        AND family_id IS NOT DISTINCT FROM $2::uuid
        AND type = 'external'`,
    [input.groupId, input.familyId],
  );
  const registration = result.rows[0];
  if (!registration) {
    throw new AppError(
      "AGENT_GROUP_REGISTRATION_INVALID",
      "Текущая регистрация внешней группы больше не действует",
    );
  }
  const allowed = parseExternalGroupToolAllowlist(registration.tool_allowlist);
  if (!allowed) {
    throw new AppError(
      "AGENT_GROUP_TOOL_POLICY_INVALID",
      "Политика инструментов внешней группы повреждена. Обратитесь к владельцу агента",
    );
  }

  return capForGroup(allowed, input);
}

export async function authorizeCurrentExternalGroupCapability(
  input: ExternalGroupPolicyIdentity,
  capability: ExternalGroupToolName,
): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ tool_allowlist: string[] }>(
      `SELECT tool_allowlist
         FROM telegram_groups
        WHERE id = $1 AND family_id IS NOT DISTINCT FROM $2::uuid AND type = 'external'
        FOR SHARE`,
      [input.groupId, input.familyId],
    );
    const parsed = parseExternalGroupToolAllowlist(result.rows[0]?.tool_allowlist);
    const allowed = parsed ? capForGroup(parsed, input) : null;
    if (!allowed?.has(capability)) {
      throw new AppError(
        "AGENT_GROUP_TOOL_FORBIDDEN",
        "Этот инструмент не разрешён в текущей внешней группе. Обратитесь к владельцу агента",
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
