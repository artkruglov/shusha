/** The operator's digest sees counters of the other families and nothing of their content. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMemoryFamilyFixture } from "../memory-repository.integration-fixtures.js";
import { formatOtherFamilies, readOtherFamiliesHealth } from "./other-families-health.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");
const suite = enabled ? describe : describe.skip;

suite("other families health", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families, users CASCADE");
  });
  afterAll(closeDatabase);

  it("counts failures of the other families only, by ordinal, with no content", async () => {
    const suffix = `other-health-${Date.now()}`;
    const operator = await createMemoryFamilyFixture(suffix);
    const quiet = await createMemoryFamilyFixture(`${suffix}-quiet`);
    const troubled = await createMemoryFamilyFixture(`${suffix}-troubled`);
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    await database().query(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, owner_user_id, scope, conversation_key, continuation_token,
          started_at, last_activity_at, rotation_requested_at, rotation_reason, kind)
       VALUES (gen_random_uuid(), 0, $1, $2, 'personal', $3, $4, now(), now(), now(), 'session_failed', 'canonical')`,
      [troubled.familyId, troubled.owner.userId, `key-${suffix}`, `token-${suffix}`],
    );
    // The operator's own failure belongs to its own block, not to this one.
    await database().query(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, owner_user_id, scope, conversation_key, continuation_token,
          started_at, last_activity_at, rotation_requested_at, rotation_reason, kind)
       VALUES (gen_random_uuid(), 0, $1, $2, 'personal', $3, $4, now(), now(), now(), 'session_failed', 'canonical')`,
      [operator.familyId, operator.owner.userId, `own-${suffix}`, `own-token-${suffix}`],
    );

    const health = await readOtherFamiliesHealth(operator.familyId, windowStart);
    const mine = health.troubled.filter((item) => item.rotations === 1);
    expect(health.families).toBe(2);
    expect(mine).toHaveLength(1);
    expect(health.troubled.every((item) => item.rotations + item.failedBatches + item.reminderFailures + item.scheduleFailures > 0)).toBe(true);
    const text = formatOtherFamilies(health)!;
    expect(text).toContain("сессий после сбоя 1");
    expect(text).not.toContain(troubled.familyId);
    expect(quiet.familyId).not.toBe(troubled.familyId);
  });

  it("says nothing when the operator is alone and a quiet line when nothing failed", () => {
    expect(formatOtherFamilies({ families: 0, troubled: [] })).toBeNull();
    expect(formatOtherFamilies({ families: 2, troubled: [] })).toBe("Другие семьи: 2, сбоев нет.");
  });
});
