/**
 * Operator entrypoint for the move notice (`bot-move-notice-core.ts`). Runs in the agent container while
 * `TELEGRAM_BOT_TOKEN` is still the old bot's:
 *   node --experimental-strip-types scripts/bot-move-notice.ts --new-username yuna_agent --text-file <f> --log <f> [--send]
 * Without `--send` it only counts. Prints counts, never ids or the token. The image has no `agent/` sources to import,
 * so the script talks to PostgreSQL through `pg` itself, in the system RLS mode the operator query needs.
 */
import { appendFile, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { sendTelegramMessage } from "eve/channels/telegram";
import pg from "pg";

import { runBotMoveNotice } from "./bot-move-notice-core.ts";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  const { values } = parseArgs({
    options: { log: { type: "string" }, "new-username": { type: "string" }, send: { type: "boolean" }, "text-file": { type: "string" } },
    strict: true,
  });
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!values.log || !values["new-username"] || !values["text-file"] || !botToken) {
    throw new Error("AGENT_BOT_MOVE_ARGUMENTS_REQUIRED: Нужны --new-username, --text-file, --log и TELEGRAM_BOT_TOKEN");
  }
  const log = values.log;
  const text = (await readFile(values["text-file"], "utf8")).trim();
  const result = await runBotMoveNotice({ newUsername: values["new-username"], send: values.send === true, text }, {
    async recipients() {
      // Every family's members: an operator query, so the system RLS mode (migration 171).
      await client.connect();
      await client.query("SELECT set_config('app.rls_system', 'on', false)");
      const { rows } = await client.query<{ id: string }>(
        `SELECT DISTINCT u.telegram_user_id AS id FROM users u JOIN family_memberships m ON m.user_id = u.id ORDER BY 1`);
      return rows.map((row) => row.id);
    },
    async alreadyNotified() {
      const content = await readFile(log, "utf8").catch(() => "");
      return new Set(content.split("\n").filter(Boolean).map((line) => line.split(" ")[0]!));
    },
    async record(chatId, outcome) {
      await appendFile(log, `${chatId} ${outcome}\n`);
    },
    async send(chatId, body) {
      try {
        await sendTelegramMessage({
          body: { text: body },
          chatId,
          credentials: { botToken },
          fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(15_000) }),
        });
        return "sent";
      } catch (error) {
        if (error instanceof Error && /\b403\b|blocked|deactivated/iu.test(error.message)) return "blocked";
        throw error;
      }
    },
    pause: (ms) => sleep(ms),
  });
  process.stdout.write(`${JSON.stringify({ code: "AGENT_BOT_MOVE_NOTICE", send: values.send === true, ...result })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  process.stderr.write(`${JSON.stringify({ code: /^AGENT_[A-Z_]+/u.exec(message)?.[0] ?? "AGENT_BOT_MOVE_NOTICE_FAILED" })}\n`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
