/** The Studio's daily limit holds under concurrent starts: the count and the reservation share one lock. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { reservePhotoUpload } from "./web-app-photo-upload.js";
import { studioReservations } from "./web-app-studio.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function workspace(): Promise<string> {
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Studio') RETURNING id");
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
     VALUES ($1, '-100-studio', 'Studio group', 'external', 'all', ARRAY['generate_image']) RETURNING id`,
    [family.rows[0]!.id]);
  const result = await database().query<{ id: string }>(
    "INSERT INTO workspaces (family_id, group_id, scope) VALUES ($1, $2, 'group') RETURNING id",
    [family.rows[0]!.id, group.rows[0]!.id]);
  return result.rows[0]!.id;
}

const begin = (workspaceId: string, key: string) => studioReservations().begin({
  inputHash: "a".repeat(64), operationKey: key, outputPath: `generated-images/${key}`, workspaceId,
});

describeWithDatabase("Studio reservations", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE image_generation_operations, telegram_groups, workspaces, families CASCADE");
  });
  afterAll(async () => closeDatabase());

  it("lets exactly one of several concurrent starts take the last picture of the day", async () => {
    const workspaceId = await workspace();
    for (let index = 0; index < 19; index += 1) await begin(workspaceId, `webapp-studio:u:earlier-${index}`);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) => begin(workspaceId, `webapp-studio:u:race-${index}`)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((value) => value.status === "rejected")) {
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: "AGENT_WEB_APP_STUDIO_LIMITED" });
    }
  });

  it("still replays a known run once the limit is reached", async () => {
    const workspaceId = await workspace();
    for (let index = 0; index < 20; index += 1) await begin(workspaceId, `webapp-studio:u:earlier-${index}`);
    await expect(begin(workspaceId, "webapp-studio:u:earlier-3")).resolves.toMatchObject({ state: "started" });
  });

  it("lets exactly one of several concurrent uploads take the last photo of the day", async () => {
    const workspaceId = await workspace();
    for (let index = 0; index < 29; index += 1) await reservePhotoUpload(workspaceId, `webapp-upload:u:earlier-${index}`, "d");
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) =>
      reservePhotoUpload(workspaceId, `webapp-upload:u:race-${index}`, "d")));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("refuses other bytes under a nonce that already reserved a photo", async () => {
    const workspaceId = await workspace();
    await reservePhotoUpload(workspaceId, "webapp-upload:u:same", "first");
    await expect(reservePhotoUpload(workspaceId, "webapp-upload:u:same", "first")).resolves.toBeUndefined();
    await expect(reservePhotoUpload(workspaceId, "webapp-upload:u:same", "second"))
      .rejects.toMatchObject({ code: "AGENT_WEB_APP_BAD_REQUEST" });
  });

  it("holds one connection per start, so many concurrent starts do not exhaust the pool", async () => {
    const workspaceId = await workspace();
    const results = await Promise.allSettled(Array.from({ length: 25 }, (_, index) =>
      begin(workspaceId, `webapp-studio:u:crowd-${index}`)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(20);
  }, 20_000);
});
