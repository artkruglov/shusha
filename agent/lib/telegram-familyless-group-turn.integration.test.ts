/**
 * A turn in a group without a family (migration 175) through the real handler and repositories.
 *
 * Constructs covered:
 * - An addressed message reaches a prepared session with group-only auth: no family attribute,
 *   role `external`, scope `group`, the group's own tool grant.
 * - Nothing of the family machinery is written for it: no memory review, no profile subjects, no
 *   family audit; the session and its audit belong to the group.
 * - An unaddressed message is journaled and wakes nothing; owner-only mode answers nobody.
 * - Past its monthly budget the group hears one notice and then nothing, and no session is prepared.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { BOT_USERNAME, telegramContext } from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";
import { productionTelegramMessageRepositories } from "./telegram-on-message-repositories.js";
import { FAMILYLESS_GROUP_BUDGET_NOTICE } from "./telegram-familyless-group-command.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
const CHAT_ID = "-100800001";

let nextMessageId = 1;

function groupMessage(text: string, fromId = "800100"): TelegramMessage {
  const messageId = String(nextMessageId++);
  return {
    attachments: [],
    caption: "",
    chat: { id: CHAT_ID, title: "Соседи", type: "supergroup" },
    from: { firstName: "Ира", id: fromId, isBot: false, username: `user${fromId}` },
    messageId,
    raw: { date: 1_760_000_000, message_id: Number(messageId) },
    text,
  };
}

async function insertGroup(messageMode: "addressed_only" | "owner_only" = "addressed_only"): Promise<string> {
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist,
        enabled_by_telegram_user_id, monthly_budget_usd)
     VALUES (NULL, $1, 'Соседи', 'external', $2, ARRAY['web_search'], '800100', 5) RETURNING id`,
    [CHAT_ID, messageMode],
  );
  return group.rows[0]!.id;
}

async function rowsOf(groupId: string) {
  const result = await database().query<Record<string, string>>(`SELECT
    (SELECT count(*) FROM conversation_sessions WHERE group_id = $1 AND family_id IS NULL) AS sessions,
    (SELECT count(*) FROM conversation_participants p JOIN application_conversations c ON c.id = p.conversation_id
      WHERE c.telegram_group_id = $1) AS participants,
    (SELECT count(*) FROM profile_subjects s JOIN application_conversations c ON c.id = s.conversation_id
      WHERE c.telegram_group_id = $1) AS subjects,
    (SELECT count(*) FROM memory_review_lanes l JOIN application_conversations c ON c.id = l.conversation_id
      WHERE c.telegram_group_id = $1) AS review_lanes,
    (SELECT count(*) FROM telegram_group_messages WHERE group_id = $1) AS journal`, [groupId]);
  return result.rows[0];
}

(enabled ? describe : describe.skip)("turn in a group without a family", () => {
  const handle = createTelegramMessageHandler(productionTelegramMessageRepositories);

  beforeEach(async () => {
    await database().query("DELETE FROM telegram_groups WHERE telegram_chat_id = $1", [CHAT_ID]);
    await database().query("DELETE FROM users WHERE telegram_user_id IN ('800100', '800101')");
    await database().query("DELETE FROM model_usage_events WHERE familyless_chat_id = $1", [CHAT_ID]);
    await database().query("DELETE FROM familyless_group_budget_notices WHERE telegram_chat_id = $1", [CHAT_ID]);
  });

  afterAll(closeDatabase);

  it("prepares a group-only turn and writes nothing of a family", async () => {
    const groupId = await insertGroup();
    const result = await handle(telegramContext().context, groupMessage(`@${BOT_USERNAME} что нового в городе?`));

    const attributes = result?.auth?.attributes as Record<string, unknown> | undefined;
    expect(attributes).toBeDefined();
    expect(attributes).not.toHaveProperty("familyId");
    expect(attributes).toMatchObject({
      groupId,
      groupType: "external",
      memoryScopes: ["group"],
      role: "external",
      telegramChatId: CHAT_ID,
      toolAllowlist: ["web_search"],
    });
    expect(await rowsOf(groupId)).toEqual({
      journal: "1", participants: "1", review_lanes: "0", sessions: "1", subjects: "0",
    });

    // The next addressed message continues the same session.
    await handle(telegramContext().context, groupMessage(`@${BOT_USERNAME} а погода?`, "800101"));
    expect(await rowsOf(groupId)).toMatchObject({ journal: "2", sessions: "1" });
  });

  it("journals an unaddressed message without waking anything", async () => {
    const groupId = await insertGroup();
    await expect(handle(telegramContext().context, groupMessage("просто болтаем"))).resolves.toBeNull();
    expect(await rowsOf(groupId)).toEqual({
      journal: "1", participants: "0", review_lanes: "0", sessions: "0", subjects: "0",
    });
  });

  it("answers nobody in owner-only mode", async () => {
    const groupId = await insertGroup("owner_only");
    await expect(handle(telegramContext().context, groupMessage(`@${BOT_USERNAME} привет`))).resolves.toBeNull();
    expect(await rowsOf(groupId)).toMatchObject({ sessions: "0" });
  });

  it("tells a group past its budget once and then stays silent", async () => {
    const groupId = await insertGroup();
    await database().query(
      `INSERT INTO model_usage_events
         (model_id, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_usd, familyless_chat_id)
       VALUES ('deepseek-v4-flash', 0, 0, 0, 5, $1)`,
      [CHAT_ID],
    );
    const first = telegramContext();
    await expect(handle(first.context, groupMessage(`@${BOT_USERNAME} привет`))).resolves.toBeNull();
    expect(first.sendMessage).toHaveBeenCalledWith(FAMILYLESS_GROUP_BUDGET_NOTICE);
    const second = telegramContext();
    await expect(handle(second.context, groupMessage(`@${BOT_USERNAME} ау`))).resolves.toBeNull();
    expect(second.sendMessage).not.toHaveBeenCalled();
    expect(await rowsOf(groupId)).toMatchObject({ journal: "2", sessions: "0" });
  });
});
