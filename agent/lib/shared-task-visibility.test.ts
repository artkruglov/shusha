/**
 * Which scope a private chat writes a new task to, by the person's choice and the family's mode.
 *
 * Constructs covered:
 * - Without a choice a task, an idea or a tradition is the person's own; a tradition is not shared by its kind.
 * - An assignment to another adult and «Для семьи» as the default still refuse with spaces.
 * - The Mini App's explicit choice wins over the default, and «только мне» cannot go with asking another adult.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import type { MemoryAuthorization } from "./memory-context.js";
import { privateTaskScope, type TaskVisibility } from "./shared-task-visibility.js";

const AUTH = { familyId: "family-1", userId: "user-1" } as MemoryAuthorization;

function client(mode: "legacy" | "spaces", visibility: TaskVisibility | null): PoolClient {
  return {
    async query(sql: string) {
      if (sql.includes("default_task_visibility")) return { rows: [{ default_task_visibility: visibility }] };
      if (sql.includes("family_space_runtime")) return { rows: [{ mode }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
}

describe("privateTaskScope", () => {
  it("writes a tradition without a choice as the person's own, in legacy and with spaces", async () => {
    await expect(privateTaskScope(client("legacy", null), AUTH, "space-1", {}))
      .resolves.toEqual({ scope: "personal", spaceId: "space-1" });
    await expect(privateTaskScope(client("spaces", null), AUTH, "space-1", {}))
      .resolves.toEqual({ scope: "personal", spaceId: "space-1" });
    await expect(privateTaskScope(client("legacy", "family"), AUTH, null, {}))
      .resolves.toEqual({ scope: "family", spaceId: null });
  });

  it("still refuses an assignment and the family default with spaces", async () => {
    await expect(privateTaskScope(client("spaces", null), AUTH, "space-1", { assigneeRef: "ref-1" }))
      .rejects.toMatchObject({ code: "AGENT_TASK_SHARED_NEEDS_SPACE" });
    await expect(privateTaskScope(client("spaces", "family"), AUTH, "space-1", {}))
      .rejects.toMatchObject({ code: "AGENT_TASK_SHARED_NEEDS_SPACE" });
    await expect(privateTaskScope(client("spaces", null), AUTH, "space-1", {}))
      .resolves.toEqual({ scope: "personal", spaceId: "space-1" });
  });

  it("takes the explicit choice over the default", async () => {
    await expect(privateTaskScope(client("legacy", "personal"), AUTH, null, { visibility: "family" }))
      .resolves.toEqual({ scope: "family", spaceId: null });
    await expect(privateTaskScope(client("legacy", "family"), AUTH, null, { visibility: "personal" }))
      .resolves.toEqual({ scope: "personal", spaceId: null });
    await expect(privateTaskScope(client("spaces", null), AUTH, "space-1", { visibility: "family" }))
      .rejects.toMatchObject({ code: "AGENT_TASK_SHARED_NEEDS_SPACE" });
    await expect(privateTaskScope(client("legacy", null), AUTH, null, { assigneeRef: "ref-1", visibility: "personal" }))
      .rejects.toMatchObject({ code: "AGENT_TASK_VISIBILITY_SHARED_WORK" });
  });
});
