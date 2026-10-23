/**
 * Turning the bot on and off in a group without a family (migrations 175 and 176).
 *
 * Constructs covered:
 * - `/start` from a Telegram administrator registers the chat with the default budget and the web
 *   grant; a repeat answers `already`; a non-administrator and a failed Telegram check change nothing.
 * - The installation ceiling holds under two concurrent enables racing for the last place.
 * - A family's group is never enabled or erased here.
 * - `/stop` erases the group with its conversation, journal and audit, and only retired sessions stay.
 * - The monthly budget counts the chat's priced calls of this UTC month, survives /stop and /start,
 *   and tells the chat once a month that it is used up.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { AppError } from "./app-error.js";
import { closeDatabase, database } from "./database.js";
import { familylessGroupRepository } from "./familyless-group-repository.js";
import { FAMILYLESS_GROUP_REPLIES, runFamilylessGroupCommand } from "./telegram-familyless-group-command.js";
import type { TelegramGroupAdminVerifier } from "./telegram-group-admin-verification.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
const PREFIX = "-100900";

const admin: TelegramGroupAdminVerifier = { requireAdministrator: async () => undefined };
const member: TelegramGroupAdminVerifier = {
  requireAdministrator: async () => {
    throw new AppError("AGENT_TELEGRAM_GROUP_OWNER_NOT_ADMIN", "not admin");
  },
};
const telegramDown: TelegramGroupAdminVerifier = {
  requireAdministrator: async () => {
    throw new AppError("AGENT_TELEGRAM_GROUP_ADMIN_CHECK_UNAVAILABLE", "down");
  },
};

// Commands of one sender are 30 s apart at least; the clock moves a minute per call.
let clock = Date.now();

function command(chat: string, name: "start" | "stop", verifier = admin) {
  clock += 60_000;
  return runFamilylessGroupCommand({
    command: name,
    now: clock,
    telegramChatId: `${PREFIX}${chat}`,
    telegramChatType: "supergroup",
    telegramUserId: "900100",
    title: "Соседи",
    verifier,
  });
}

async function groupRow(chat: string) {
  const result = await database().query<{ budget: string; enabled_by: string; tools: string[] }>(
    `SELECT monthly_budget_usd::text AS budget, enabled_by_telegram_user_id AS enabled_by, tool_allowlist AS tools
       FROM telegram_groups WHERE telegram_chat_id = $1 AND family_id IS NULL`,
    [`${PREFIX}${chat}`],
  );
  return result.rows[0] ?? null;
}

(enabled ? describe : describe.skip)("groups without a family: enable and disable", () => {
  beforeEach(async () => {
    await database().query("DELETE FROM telegram_groups WHERE family_id IS NULL OR telegram_chat_id LIKE $1", [`${PREFIX}%`]);
    await database().query("DELETE FROM families WHERE name = 'Familyless command test'");
    await database().query("DELETE FROM model_usage_events WHERE familyless_chat_id LIKE $1", [`${PREFIX}%`]);
    await database().query("DELETE FROM familyless_group_budget_notices WHERE telegram_chat_id LIKE $1", [`${PREFIX}%`]);
    await database().query("UPDATE familyless_group_settings SET max_groups = 20, default_monthly_budget_usd = 1.00");
  });

  afterAll(async () => {
    await database().query("UPDATE familyless_group_settings SET max_groups = 20, default_monthly_budget_usd = 1.00");
    await closeDatabase();
  });

  it("enables for an administrator with the default budget and the web grant, once", async () => {
    await expect(command("1", "start")).resolves.toBe(FAMILYLESS_GROUP_REPLIES.enabled);
    expect(await groupRow("1")).toMatchObject({ budget: "1.00", enabled_by: "900100" });
    expect((await groupRow("1"))?.tools.sort()).toEqual(["web_fetch", "web_search"]);
    await expect(command("1", "start")).resolves.toBe(FAMILYLESS_GROUP_REPLIES.already);
  });

  it("changes nothing for a member or when Telegram cannot answer", async () => {
    await expect(command("2", "start", member)).resolves.toBe(FAMILYLESS_GROUP_REPLIES.not_admin);
    await expect(command("2", "start", telegramDown)).resolves.toBe(FAMILYLESS_GROUP_REPLIES.admin_check_failed);
    expect(await groupRow("2")).toBeNull();
    await command("2", "start");
    await expect(command("2", "stop", member)).resolves.toBe(FAMILYLESS_GROUP_REPLIES.not_admin);
    expect(await groupRow("2")).not.toBeNull();
  });

  it("holds the ceiling when two enables race for the last place", async () => {
    await database().query("UPDATE familyless_group_settings SET max_groups = 1");
    const results = await Promise.all(["3", "4"].map((chat) => familylessGroupRepository.enable({
      enabledByTelegramUserId: "900100",
      telegramChatId: `${PREFIX}${chat}`,
      telegramChatType: "supergroup",
      title: "Гонка",
    })));
    expect(results.sort()).toEqual(["enabled", "full"]);
    const count = await database().query<{ n: number }>(
      "SELECT count(*)::integer AS n FROM telegram_groups WHERE family_id IS NULL");
    expect(count.rows[0]?.n).toBe(1);
  });

  it("never enables or erases a family's group", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Familyless command test') RETURNING id");
    await database().query(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, $2, 'Семья', 'external', 'addressed_only')`,
      [family.rows[0]!.id, `${PREFIX}5`],
    );
    await expect(command("5", "start")).resolves.toBe(FAMILYLESS_GROUP_REPLIES.taken);
    await expect(command("5", "stop")).resolves.toBe(FAMILYLESS_GROUP_REPLIES.taken);
    const still = await database().query("SELECT 1 FROM telegram_groups WHERE telegram_chat_id = $1", [`${PREFIX}5`]);
    expect(still.rowCount).toBe(1);
  });

  it("erases the group with its conversation, journal and audit", async () => {
    await command("6", "start");
    const group = await database().query<{ id: string }>(
      "SELECT id FROM telegram_groups WHERE telegram_chat_id = $1", [`${PREFIX}6`]);
    const groupId = group.rows[0]!.id;
    await database().query(
      "INSERT INTO audit_events (family_id, group_id, event_type) VALUES (NULL, $1, 'probe')", [groupId]);
    await expect(command("6", "stop")).resolves.toBe(FAMILYLESS_GROUP_REPLIES.disabled);
    const left = await database().query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM telegram_groups WHERE id = $1) AS groups,
      (SELECT count(*) FROM application_conversations WHERE telegram_group_id = $1) AS conversations,
      (SELECT count(*) FROM telegram_group_messages WHERE group_id = $1) AS journal,
      (SELECT count(*) FROM audit_events WHERE group_id = $1) AS audit`, [groupId]);
    expect(left.rows[0]).toEqual({ audit: "0", conversations: "0", groups: "0", journal: "0" });
    await expect(command("6", "stop")).resolves.toBe(FAMILYLESS_GROUP_REPLIES.absent);
  });

  it("stops a chat past its monthly budget, tells it once, and keeps the spend across /stop and /start", async () => {
    const chatId = `${PREFIX}7`;
    const bill = (costUsd: number, at: string) => database().query(
      `INSERT INTO model_usage_events
         (model_id, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_usd, created_at, familyless_chat_id)
       VALUES ('deepseek-v4-flash', 0, 0, 0, $1, $2, $3)`,
      [costUsd, at, chatId],
    );
    const gate = async (now: string) => {
      const group = await database().query<{ id: string }>(
        "SELECT id FROM telegram_groups WHERE telegram_chat_id = $1", [chatId]);
      return familylessGroupRepository.budgetGate({ groupId: group.rows[0]!.id, now: new Date(now), telegramChatId: chatId });
    };
    await command("7", "start");
    await bill(0.9, "2026-09-30T23:00:00Z");
    await bill(0.6, "2026-10-02T10:00:00Z");
    await expect(gate("2026-10-15T12:00:00Z")).resolves.toBe("within");
    await bill(0.4, "2026-10-10T10:00:00Z");
    await expect(gate("2026-10-15T12:00:00Z")).resolves.toBe("notify");
    await expect(gate("2026-10-15T12:05:00Z")).resolves.toBe("silent");

    // A new row for the same chat inherits the month's spend and its notice: nothing is said twice.
    await command("7", "stop");
    await command("7", "start");
    await expect(gate("2026-10-16T09:00:00Z")).resolves.toBe("silent");
    await expect(gate("2026-11-01T00:00:00Z")).resolves.toBe("within");
    // A call the price table cannot price closes the budget rather than counting as free.
    await database().query(
      `INSERT INTO model_usage_events
         (model_id, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_usd, created_at, familyless_chat_id)
       VALUES ('unknown-model', 0, 0, 0, NULL, '2026-11-02T10:00:00Z', $1)`,
      [chatId],
    );
    await expect(gate("2026-11-03T00:00:00Z")).resolves.toBe("notify");
  });

  it("ignores a repeat of the same sender inside the cooldown without asking Telegram", async () => {
    let checks = 0;
    const counting: TelegramGroupAdminVerifier = { requireAdministrator: async () => { checks += 1; } };
    const at = Date.now() + 10 * 86_400_000;
    const run = (now: number) => runFamilylessGroupCommand({
      command: "start", now, telegramChatId: `${PREFIX}8`, telegramChatType: "supergroup",
      telegramUserId: "900100", title: "x", verifier: counting,
    });
    await expect(run(at)).resolves.toBe(FAMILYLESS_GROUP_REPLIES.enabled);
    await expect(run(at + 5_000)).resolves.toBeNull();
    await expect(run(at + 31_000)).resolves.toBe(FAMILYLESS_GROUP_REPLIES.already);
    expect(checks).toBe(2);
  });
});
