/**
 * Session handoff repository tests (PostgreSQL).
 *
 * Constructs covered:
 * - A stored handoff is read while no turn has shown it; marking it shown ends that, and a
 *   second mark keeps the first timestamp.
 * - A retired session reads nothing and storing on it is a no-op that reports it.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionHandoffRepository } from "./session-handoff-repository.js";
import { sessionRepository } from "./session-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("sessionHandoffRepository", () => {
  let familyId: string;
  let userId: string;

  beforeEach(async () => {
    await database().query(
      "TRUNCATE conversation_session_routes, conversation_sessions, conversation_route_generations, family_memberships, users, families CASCADE",
    );
    familyId = (await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Handoff') RETURNING id")).rows[0]!.id;
    userId = (await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('handoff-owner', 'Owner') RETURNING id",
    )).rows[0]!.id;
    await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [familyId, userId]);
  });
  afterAll(closeDatabase);

  async function shownAt(sessionId: string): Promise<Date | null> {
    return (await database().query<{ handoff_shown_at: Date | null }>(
      "SELECT handoff_shown_at FROM conversation_sessions WHERE id = $1", [sessionId],
    )).rows[0]!.handoff_shown_at;
  }

  it("stores the handoff on the active session and reads it until a turn marks it shown", async () => {
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: "301::", familyId, groupId: null, kind: "canonical",
      now: new Date("2026-10-15T12:00:00.000Z"), scope: "personal", telegramForumTopicId: null, userId,
    });
    await expect(sessionHandoffRepository.read(session.id)).resolves.toBeNull();
    // Nothing to mark yet: the row stays untouched.
    await sessionHandoffRepository.markShown(session.id);
    await expect(shownAt(session.id)).resolves.toBeNull();

    await expect(sessionHandoffRepository.store(session.id, { latencyMs: 4_200, sourceEntries: 57, text: "О чём шёл разговор\n- вода" }))
      .resolves.toBe("stored");
    const row = (await database().query<{ handoff_latency_ms: number; handoff_source_entries: number; handoff_generated_at: Date | null }>(
      "SELECT handoff_latency_ms, handoff_source_entries, handoff_generated_at FROM conversation_sessions WHERE id = $1", [session.id],
    )).rows[0]!;
    expect(row).toMatchObject({ handoff_latency_ms: 4_200, handoff_source_entries: 57 });
    expect(row.handoff_generated_at).not.toBeNull();

    // A preparation that fails after reading leaves the summary for the next turn.
    await expect(sessionHandoffRepository.read(session.id)).resolves.toBe("О чём шёл разговор\n- вода");
    await expect(sessionHandoffRepository.read(session.id)).resolves.toBe("О чём шёл разговор\n- вода");

    await sessionHandoffRepository.markShown(session.id);
    const first = await shownAt(session.id);
    expect(first).not.toBeNull();
    await expect(sessionHandoffRepository.read(session.id)).resolves.toBeNull();
    await sessionHandoffRepository.markShown(session.id);
    await expect(shownAt(session.id)).resolves.toEqual(first);
  });

  it("does nothing for a retired session", async () => {
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: "302::", familyId, groupId: null, kind: "canonical",
      now: new Date("2026-10-15T12:00:00.000Z"), scope: "personal", telegramForumTopicId: null, userId,
    });
    await sessionHandoffRepository.store(session.id, { latencyMs: 1, sourceEntries: 1, text: "нить" });
    await database().query("UPDATE conversation_sessions SET retired_at = now(), delete_after = now() WHERE id = $1", [session.id]);
    await expect(sessionHandoffRepository.read(session.id)).resolves.toBeNull();
    await expect(sessionHandoffRepository.store(session.id, { latencyMs: 1, sourceEntries: 1, text: "поздно" })).resolves.toBe("session_retired");
  });
});
