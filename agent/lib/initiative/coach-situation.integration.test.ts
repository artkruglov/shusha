/**
 * Повод коуча «как прошло?» на настоящей базе: только личное событие самого человека с датой в
 * окне «через 20 часов … 10 дней», один вопрос на запись.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMainAgentPrivateMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { memoryRepository } from "../memory-repository.js";
import { findOpenSituation } from "./coach-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const dbDescribe = enabled ? describe : describe.skip;
const NOW = new Date("2026-09-30T15:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

async function episode(fixture: Awaited<ReturnType<typeof createMainAgentPrivateMemoryFixture>>, key: string, occurredAt: string, attribute?: string) {
  return memoryRepository.create(fixture.auth, {
    ...(attribute === undefined ? {} : { attribute }),
    confirmation: "model_high",
    content: `Приём врача ${key}`,
    explicitSource: { conversationId: fixture.conversationId, subject: { kind: "current_author" }, timelineEntryId: fixture.timelineEntryId },
    kind: "episode",
    occurredAt,
    operationKey: key,
    provenance: { sessionId: "eve-session-sit", turnId: `eve-turn-${key}` },
    scope: "personal",
    sensitivity: "normal",
    source: `eve:eve-session-sit:eve-turn-${key}`,
  });
}

dbDescribe("coach situation follow-up", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });
  afterAll(closeDatabase);

  it("picks a personal event from the last days, not today's and not old ones, and asks once", async () => {
    const fixture = await createMainAgentPrivateMemoryFixture();
    const familyId = fixture.auth.familyId;
    await episode(fixture, "today", day(0.2));
    await episode(fixture, "old", day(12));
    expect(await findOpenSituation(familyId, fixture.userId, NOW)).toBeNull();

    const recent = await episode(fixture, "recent", day(2));
    expect(await findOpenSituation(familyId, fixture.userId, NOW)).toEqual({ id: recent.id, text: "Приём врача recent" });

    await database().query(
      `INSERT INTO initiative_messages(family_id, user_id, kind, sent_on, sent_at, coach_reason, coach_subject)
       VALUES ($1, $2, 'coach', '2026-09-30', $3, 'situation_followup', $4)`,
      [familyId, fixture.userId, NOW, recent.id],
    );
    expect(await findOpenSituation(familyId, fixture.userId, NOW)).toBeNull();
  });

  it("never reads a discussion summary slot or another person's events", async () => {
    const fixture = await createMainAgentPrivateMemoryFixture();
    await episode(fixture, "summary", day(2), "итог обсуждения");
    expect(await findOpenSituation(fixture.auth.familyId, fixture.userId, NOW)).toBeNull();
    const stranger = await database().query<{ id: string }>("INSERT INTO users (telegram_user_id, display_name) VALUES ('x', 'Икс') RETURNING id");
    await episode(fixture, "mine", day(2));
    expect(await findOpenSituation(fixture.auth.familyId, stranger.rows[0]!.id, NOW)).toBeNull();
  });
});
