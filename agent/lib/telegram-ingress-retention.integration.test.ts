/**
 * Retention of the durable Telegram ingress queue.
 *
 * Constructs covered:
 * - Completed updates older than the window are deleted, with their interjection rows; recent
 *   completed ones stay, and so do pending, processing and failed ones of any age (a failure is
 *   kept for diagnosis and for the owner's digest).
 * - The purge works in bounded batches.
 * - A failed guest update past the window is deleted, and so is its emptied guest queue; a recent
 *   failed guest update and its queue stay.
 * - An emptied button-press queue past the window is deleted too; an ordinary chat queue stays.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { TELEGRAM_INGRESS_RETENTION_DAYS } from "../config.js";
import { closeDatabase, database } from "./database.js";
import { purgeCompletedTelegramUpdates } from "./telegram-ingress-retention.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

const NOW = new Date("2026-10-05T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - (TELEGRAM_INGRESS_RETENTION_DAYS + 1) * 86_400_000);
const RECENT = new Date(NOW.getTime() - (TELEGRAM_INGRESS_RETENTION_DAYS - 1) * 86_400_000);

let queueId = "";

async function insertUpdate(
  updateId: number,
  status: string,
  completedAt: Date | null,
  queue: { id: string; key: string } = { id: queueId, key: "telegram:1" },
  updatedAt: Date = completedAt ?? OLD,
): Promise<void> {
  const leased = status === "processing";
  await database().query(
    `INSERT INTO telegram_ingress_updates
       (update_id, queue_id, ingress_continuation_key, payload, status, completed_at, received_at,
        lease_token, lease_expires_at, updated_at)
     VALUES ($1, $2, $3, '{"message":{"chat":{"id":"1","type":"private"},"text":"x"}}',
             $4, $5, $6, $7, $8, $9)`,
    [updateId, queue.id, queue.key, status, completedAt, completedAt ?? OLD,
      leased ? "00000000-0000-4000-8000-000000000009" : null, leased ? new Date(NOW.getTime() + 60_000) : null,
      updatedAt],
  );
}

async function insertGuestQueue(
  queryId: string,
  createdAt: Date,
  key = `telegram:guest:${queryId}`,
): Promise<{ id: string; key: string }> {
  const queue = await database().query<{ id: string }>(
    "INSERT INTO telegram_ingress_queues (current_continuation_key, created_at) VALUES ($1, $2) RETURNING id",
    [key, createdAt],
  );
  return { id: queue.rows[0]!.id, key };
}

async function remaining(): Promise<number[]> {
  const rows = await database().query<{ update_id: string }>(
    "SELECT update_id::text FROM telegram_ingress_updates ORDER BY update_id",
  );
  return rows.rows.map((row) => Number(row.update_id));
}

describeWithDatabase("telegram ingress retention", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_ingress_updates, telegram_ingress_queues CASCADE");
    const queue = await database().query<{ id: string }>(
      "INSERT INTO telegram_ingress_queues (current_continuation_key) VALUES ('telegram:1') RETURNING id",
    );
    queueId = queue.rows[0]!.id;
  });

  afterAll(closeDatabase);

  it("deletes only completed updates past the window", async () => {
    await insertUpdate(1, "completed", OLD);
    await insertUpdate(2, "completed", RECENT);
    await insertUpdate(3, "failed", OLD);
    await insertUpdate(4, "pending", null);
    await insertUpdate(5, "processing", null);

    await expect(purgeCompletedTelegramUpdates(NOW)).resolves.toBe(1);
    expect(await remaining()).toEqual([2, 3, 4, 5]);
  });

  it("purges in bounded batches", async () => {
    for (let id = 1; id <= 5; id += 1) await insertUpdate(id, "completed", OLD);

    await expect(purgeCompletedTelegramUpdates(NOW, 2)).resolves.toBe(2);
    expect(await remaining()).toHaveLength(3);
  });

  it("deletes failed guest updates past the window and their emptied queues", async () => {
    const oldGuest = await insertGuestQueue("old", OLD);
    const recentGuest = await insertGuestQueue("recent", RECENT);
    await insertUpdate(1, "failed", null, oldGuest, OLD);
    await insertUpdate(2, "failed", null, recentGuest, RECENT);
    await insertUpdate(3, "failed", OLD);

    await expect(purgeCompletedTelegramUpdates(NOW)).resolves.toBe(1);
    expect(await remaining()).toEqual([2, 3]);
    const queues = await database().query<{ current_continuation_key: string }>(
      "SELECT current_continuation_key FROM telegram_ingress_queues ORDER BY current_continuation_key",
    );
    expect(queues.rows.map((row) => row.current_continuation_key)).toEqual(["telegram:1", "telegram:guest:recent"]);
  });

  it("deletes emptied button-press queues past the window", async () => {
    const oldPress = await insertGuestQueue("cb-old", OLD, "telegram:callback:cb-old");
    await insertGuestQueue("cb-recent", RECENT, "telegram:callback:cb-recent");
    await insertUpdate(1, "completed", OLD, oldPress);

    await expect(purgeCompletedTelegramUpdates(NOW)).resolves.toBe(1);
    const queues = await database().query<{ current_continuation_key: string }>(
      "SELECT current_continuation_key FROM telegram_ingress_queues ORDER BY current_continuation_key",
    );
    expect(queues.rows.map((row) => row.current_continuation_key)).toEqual(["telegram:1", "telegram:callback:cb-recent"]);
  });
});
