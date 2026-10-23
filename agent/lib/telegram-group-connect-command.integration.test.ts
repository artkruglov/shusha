/**
 * `/start@бот group` на настоящей схеме: владелец и администратор подключает обычную группу своей семьи.
 *
 * Constructs covered:
 * - Регистрация `external` с режимом `all` и ровно четырьмя возможностями; повтор отвечает `already`.
 * - Участник семьи, посторонний и владелец без прав администратора в Telegram получают отказ, строки нет.
 * - Семья в режиме пространств получает отказ `spaces`, строки нет.
 * - Семейная группа не меняет тип и остаётся той же строкой; группа другой семьи и группа без семьи остаются как были.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { AppError } from "./app-error.js";
import { closeDatabase, database } from "./database.js";
import type { TelegramGroupAdminVerifier } from "./telegram-group-admin-verification.js";
import { registerGroupByCommand } from "./telegram-group-connect-command.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const admin: TelegramGroupAdminVerifier = { requireAdministrator: async () => undefined };
const notAdmin: TelegramGroupAdminVerifier = {
  requireAdministrator: async () => { throw new AppError("AGENT_TELEGRAM_GROUP_OWNER_NOT_ADMIN", "не админ"); },
};
const unreachable: TelegramGroupAdminVerifier = {
  requireAdministrator: async () => { throw new AppError("AGENT_TELEGRAM_GROUP_ADMIN_CHECK_FAILED", "сбой"); },
};
const suite = enabled ? describe : describe.skip;

async function family(label: string, ownerTelegramId: string, memberTelegramId: string): Promise<string> {
  const created = await database().query<{ id: string }>("INSERT INTO families(name) VALUES($1) RETURNING id", [label]);
  const familyId = created.rows[0]!.id;
  for (const [telegramId, role] of [[ownerTelegramId, "owner"], [memberTelegramId, "member"]] as const) {
    const user = await database().query<{ id: string }>(
      "INSERT INTO users(telegram_user_id, display_name) VALUES($1, $1) RETURNING id", [telegramId]);
    await database().query(
      "INSERT INTO family_memberships(family_id, user_id, role) VALUES($1,$2,$3)", [familyId, user.rows[0]!.id, role]);
  }
  return familyId;
}

const groupRow = async (chatId: string) => (await database().query(
  "SELECT family_id, type, message_mode, tool_allowlist, title FROM telegram_groups WHERE telegram_chat_id = $1", [chatId])).rows[0];

suite("/start group command", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE shared_tasks, telegram_groups, spaces, family_memberships, family_member_bans, users, families CASCADE");
  });
  afterAll(closeDatabase);

  it("registers an external group of the owner's family with exactly the four capabilities, once", async () => {
    const familyId = await family("a", "9101", "9102");
    await expect(registerGroupByCommand({ verifier: admin, telegramChatId: "-100211", telegramUserId: "9101", title: "Дача" }))
      .resolves.toBe("registered");
    expect(await groupRow("-100211")).toEqual({
      family_id: familyId, message_mode: "all", title: "Дача", type: "external",
      tool_allowlist: ["manage_shared_tasks", "remember", "search_memories", "list_memories"],
    });
    await expect(registerGroupByCommand({ verifier: admin, telegramChatId: "-100211", telegramUserId: "9101", title: "Другое" }))
      .resolves.toBe("already");
    expect((await groupRow("-100211")).title).toBe("Дача");
  });

  it("refuses a member, a stranger, an owner who is not an administrator, and an unverifiable check", async () => {
    await family("a", "9101", "9102");
    await expect(registerGroupByCommand({ verifier: admin, telegramChatId: "-100212", telegramUserId: "9102", title: "x" }))
      .resolves.toBe("not_owner");
    await expect(registerGroupByCommand({ verifier: admin, telegramChatId: "-100212", telegramUserId: "7777", title: "x" }))
      .resolves.toBe("not_owner");
    await expect(registerGroupByCommand({ verifier: notAdmin, telegramChatId: "-100212", telegramUserId: "9101", title: "x" }))
      .resolves.toBe("not_admin");
    await expect(registerGroupByCommand({ verifier: unreachable, telegramChatId: "-100212", telegramUserId: "9101", title: "x" }))
      .resolves.toBe("admin_check_failed");
    expect(await groupRow("-100212")).toBeUndefined();
  });

  it("refuses a family in the spaces mode without registering anything", async () => {
    const familyId = await family("a", "9101", "9102");
    await database().query(
      "UPDATE family_space_runtime SET mode='spaces', cutover_at=now(), reason='Переход' WHERE family_id=$1", [familyId]);
    await expect(registerGroupByCommand({ verifier: admin, telegramChatId: "-100216", telegramUserId: "9101", title: "x" }))
      .resolves.toBe("spaces");
    expect(await groupRow("-100216")).toBeUndefined();
  });

  it("never re-types a family group: the same row stays", async () => {
    const familyId = await family("a", "9101", "9102");
    await database().query(
      "INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, tool_allowlist, message_mode) VALUES($1,'-100213','Мы','family_private','{}','all')",
      [familyId]);
    const group = await database().query<{ id: string }>("SELECT id FROM telegram_groups WHERE telegram_chat_id = '-100213'");
    // Смена типа удаляет строку со всеми данными группы каскадом: тот же id значит, что её не тронули.
    const before = group.rows[0]!.id;
    await expect(registerGroupByCommand({ verifier: admin, telegramChatId: "-100213", telegramUserId: "9101", title: "Мы" }))
      .resolves.toBe("other_type");
    expect(await groupRow("-100213")).toMatchObject({ tool_allowlist: [], type: "family_private" });
    expect((await database().query<{ id: string }>("SELECT id FROM telegram_groups WHERE telegram_chat_id = '-100213'")).rows[0]!.id)
      .toBe(before);
  });

  it("leaves another family's group and a group without a family alone", async () => {
    await family("a", "9101", "9102");
    await family("b", "9201", "9202");
    await registerGroupByCommand({ verifier: admin, telegramChatId: "-100214", telegramUserId: "9201", title: "B" });
    await expect(registerGroupByCommand({ verifier: admin, telegramChatId: "-100214", telegramUserId: "9101", title: "A" }))
      .resolves.toBe("other_family");
    expect((await groupRow("-100214")).title).toBe("B");
    await database().query(
      `INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, message_mode, enabled_by_telegram_user_id, monthly_budget_usd)
       VALUES(NULL,'-100215','free','external','addressed_only','9301',1)`);
    await expect(registerGroupByCommand({ verifier: admin, telegramChatId: "-100215", telegramUserId: "9101", title: "free" }))
      .resolves.toBe("familyless");
    expect((await groupRow("-100215")).family_id).toBeNull();
  });
});
