/**
 * Light capacity measurement before the friends beta: N synthetic families write to the bot at once.
 *
 * Every adult of every family sends one private message per round, all rounds start together, and
 * each turn lists the person's tasks through the real tool (the deterministic model of `agent.ts`,
 * scenario `conversation-load`). Measured: seconds from the stored update to its completed turn
 * (p50, p95, max), wall time per round and the resident memory of this process, which hosts the
 * agent. The model answers instantly, so the numbers are the runtime's own cost and the queue's
 * fairness; a real turn adds the model's seconds on top (prod p50 and p95 are in the chronicle).
 *
 * Size: CAPACITY_FAMILIES (default 10) and CAPACITY_ROUNDS (default 3).
 */
import assert from "node:assert/strict";
import { defineEval } from "eve/evals";
import { closeDatabase, database } from "../../../agent/lib/database.js";

const FAMILIES = Number(process.env.CAPACITY_FAMILIES ?? 10);
const ROUNDS = Number(process.env.CAPACITY_ROUNDS ?? 3);
const FIRST_TELEGRAM_ID = 950_000;
const FIRST_UPDATE_ID = 950_000_000;
const SECRET = "conversation-test-secret-0123456789abcdef";

function percentile(sorted: readonly number[], share: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)]!;
}

function residentMegabytes(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

export default defineEval({
  timeoutMs: 900_000,
  async test(t) {
    assert.equal(process.env.RUN_DATABASE_INTEGRATION_TESTS, "true");
    assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/osinara_test");
    assert.ok(Number.isInteger(FAMILIES) && FAMILIES > 0 && Number.isInteger(ROUNDS) && ROUNDS > 0);
    const db = database();
    await db.query("TRUNCATE users, families CASCADE");
    const people: number[] = [];
    let peak = residentMegabytes();
    const sampler = setInterval(() => { peak = Math.max(peak, residentMegabytes()); }, 200);
    try {
      await db.query(`CREATE TABLE telegram_conversation_test_deliveries (
        id integer GENERATED ALWAYS AS IDENTITY (START WITH 10000), body jsonb NOT NULL)`);
      await db.query("CREATE TABLE telegram_conversation_test_sandboxes (eve_session_id text NOT NULL, mounts jsonb NOT NULL)");
      for (let family = 0; family < FAMILIES; family += 1) {
        const id = (await db.query<{ id: string }>("INSERT INTO families(name) VALUES ($1) RETURNING id", [`Load ${family}`])).rows[0]!.id;
        for (const [offset, role] of [[0, "owner"], [1, "member"]] as const) {
          const telegramId = FIRST_TELEGRAM_ID + family * 2 + offset;
          const user = (await db.query<{ id: string }>(
            "INSERT INTO users(telegram_user_id,display_name) VALUES($1,$2) RETURNING id", [String(telegramId), `Load ${telegramId}`],
          )).rows[0]!.id;
          await db.query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,$3)", [id, user, role]);
          await db.query("INSERT INTO user_notification_settings(user_id,timezone) VALUES($1,'UTC')", [user]);
          people.push(telegramId);
        }
      }
      const baseline = residentMegabytes();
      const rounds: number[] = [];
      let sequence = 0;
      for (let round = 1; round <= ROUNDS; round += 1) {
        const started = Date.now();
        const updateIds = await Promise.all(people.map(async (telegramId) => {
          sequence += 1;
          const updateId = FIRST_UPDATE_ID + sequence;
          const response = await t.target.fetch("/eve/v1/telegram", {
            method: "POST",
            headers: { "x-telegram-bot-api-secret-token": SECRET },
            body: JSON.stringify({ update_id: updateId, message: {
              message_id: sequence,
              chat: { id: telegramId, type: "private" },
              date: Math.floor(Date.now() / 1_000),
              from: { id: telegramId, first_name: "Load", is_bot: false },
              text: `Осинара, conversation-load-${sequence}`,
            } }),
          });
          assert.equal(response.status, 200);
          return updateId;
        }));
        for (let poll = 0; ; poll += 1) {
          const rows = (await db.query<{ status: string; last_error_code: string | null }>(
            "SELECT status, last_error_code FROM telegram_ingress_updates WHERE update_id = ANY($1::bigint[])", [updateIds],
          )).rows;
          const failed = rows.find((row) => row.status === "failed");
          if (failed) throw new Error(`TEST_CAPACITY_TURN_FAILED: ${failed.last_error_code}`);
          if (rows.length === updateIds.length && rows.every((row) => row.status === "completed")) break;
          if (poll > 6_000) throw new Error(`TEST_CAPACITY_STALLED in round ${round}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        rounds.push(Math.round((Date.now() - started) / 100) / 10);
      }
      const latencies = (await db.query<{ seconds: number }>(
        `SELECT extract(epoch FROM completed_at - received_at)::float AS seconds FROM telegram_ingress_updates
          WHERE update_id BETWEEN $1 AND $2 ORDER BY 1`,
        [FIRST_UPDATE_ID + 1, FIRST_UPDATE_ID + sequence],
      )).rows.map((row) => Math.round(row.seconds * 10) / 10);
      assert.equal(latencies.length, sequence);
      // Every turn answered once, in the chat that asked.
      const replies = (await db.query<{ chat: string; text: string }>(
        "SELECT body->>'chat_id' AS chat, body->>'text' AS text FROM telegram_conversation_test_deliveries WHERE body->>'text' LIKE '%reply-conversation-load-%'",
      )).rows;
      assert.equal(replies.length, sequence, "one reply per turn");
      t.log(`CAPACITY_SUMMARY ${JSON.stringify({
        families: FAMILIES,
        people: people.length,
        turns: sequence,
        roundSeconds: rounds,
        turnSeconds: { max: latencies.at(-1), p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
        turnsPerMinute: Math.round(sequence / rounds.reduce((sum, value) => sum + value, 0) * 60),
        residentMegabytes: { baseline, peak },
      })}`);
    } finally {
      clearInterval(sampler);
      await db.query("TRUNCATE users, families CASCADE");
      await db.query("DELETE FROM telegram_ingress_updates WHERE update_id > $1", [FIRST_UPDATE_ID]);
      await db.query("DROP TABLE IF EXISTS telegram_conversation_test_deliveries, telegram_conversation_test_sandboxes");
      await closeDatabase();
    }
  },
});
