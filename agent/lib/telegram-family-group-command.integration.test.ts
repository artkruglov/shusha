/** `/family`: владелец подключает группу, остальные и чужие группы остаются как были. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import type { TelegramGroupAdminVerifier } from "./telegram-group-admin-verification.js";
import { AppError } from "./app-error.js";
import { FAMILY_GROUP_COMMAND_PATTERN, autoJoinFamilyGroupMember, registerFamilyGroupByCommand } from "./telegram-family-group-command.js";
import { telegramGroupAdministrationRepository } from "./telegram-group-administration-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const admin: TelegramGroupAdminVerifier = { requireAdministrator: async () => undefined };
const notAdmin: TelegramGroupAdminVerifier = {
  requireAdministrator: async () => { throw new AppError("AGENT_TELEGRAM_GROUP_OWNER_NOT_ADMIN", "не админ"); },
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

suite("/family group command", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE shared_tasks, telegram_groups, spaces, family_memberships, family_member_bans, users, families CASCADE");
  });
  afterAll(closeDatabase);

  it("registers the group for the owner as a listening family group, once", async () => {
    const familyId = await family("a", "9101", "9102");
    await expect(registerFamilyGroupByCommand({ verifier: admin, telegramChatId: "-100111", telegramUserId: "9101", title: "Мы" }))
      .resolves.toBe("registered");
    expect((await database().query(
      "SELECT family_id, type, message_mode, title FROM telegram_groups WHERE telegram_chat_id = '-100111'")).rows[0])
      .toEqual({ family_id: familyId, message_mode: "all", title: "Мы", type: "family_private" });
    await expect(registerFamilyGroupByCommand({ verifier: admin, telegramChatId: "-100111", telegramUserId: "9101", title: "Мы" }))
      .resolves.toBe("already");
  });

  it("refuses a plain member, a stranger and another family's group", async () => {
    await family("a", "9101", "9102");
    await family("b", "9201", "9202");
    await expect(registerFamilyGroupByCommand({ verifier: admin, telegramChatId: "-100112", telegramUserId: "9102", title: "x" }))
      .resolves.toBe("not_owner");
    await expect(registerFamilyGroupByCommand({ verifier: admin, telegramChatId: "-100112", telegramUserId: "7777", title: "x" }))
      .resolves.toBe("not_owner");
    await registerFamilyGroupByCommand({ verifier: admin, telegramChatId: "-100113", telegramUserId: "9101", title: "A" });
    await expect(registerFamilyGroupByCommand({ verifier: admin, telegramChatId: "-100113", telegramUserId: "9201", title: "B" }))
      .resolves.toBe("other_family");
    expect((await database().query("SELECT count(*)::int AS n FROM telegram_groups")).rows[0]!.n).toBe(1);
  });

  it("never turns an external group into a family one", async () => {
    const familyId = await family("a", "9101", "9102");
    await database().query(
      "INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, tool_allowlist, message_mode) VALUES($1,'-100114','ext','external','{}','addressed_only')",
      [familyId]);
    await expect(registerFamilyGroupByCommand({ verifier: admin, telegramChatId: "-100114", telegramUserId: "9101", title: "ext" }))
      .resolves.toBe("other_type");
  });

  it("tells the owner that a group without a family must be turned off first", async () => {
    await family("a", "9101", "9102");
    await database().query(
      `INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, message_mode, enabled_by_telegram_user_id, monthly_budget_usd)
       VALUES(NULL,'-100116','free','external','addressed_only','9301',1)`);
    await expect(registerFamilyGroupByCommand({ verifier: admin, telegramChatId: "-100116", telegramUserId: "9101", title: "free" }))
      .resolves.toBe("familyless");
    expect((await database().query("SELECT family_id FROM telegram_groups WHERE telegram_chat_id = '-100116'")).rows[0])
      .toEqual({ family_id: null });
  });

  it("refuses to remove an external group with open tasks, which would be deleted with it, and removes it after", async () => {
    const familyId = await family("a", "9101", "9102");
    const owner = await database().query<{ id: string }>("SELECT id FROM users WHERE telegram_user_id = '9101'");
    const group = await database().query<{ id: string }>(
      "INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, tool_allowlist, message_mode) VALUES($1,'-100118','ext','external','{}','addressed_only') RETURNING id",
      [familyId]);
    const groupId = group.rows[0]!.id;
    for (const [title, status] of [["Сверить счёт", "accepted"], ["Позвонить", "proposed"], ["Готово", "completed"]] as const) {
      await database().query(
        `INSERT INTO shared_tasks(family_id, group_id, scope, creator_telegram_id, assignee_telegram_id, title, status)
         VALUES($1,$2,'group','9101','9101',$3,$4)`, [familyId, groupId, title, status]);
    }
    const remove = () => telegramGroupAdministrationRepository.removeRegistration({
      familyId, requestedBy: owner.rows[0]!.id, telegramChatId: "-100118",
    });
    await expect(remove()).rejects.toMatchObject({
      code: "AGENT_GROUP_HAS_OPEN_TASKS", message: expect.stringContaining("2 незакрытых дела"),
    });
    expect((await database().query("SELECT count(*)::int AS n FROM shared_tasks WHERE group_id = $1", [groupId])).rows[0]!.n).toBe(3);

    await database().query("UPDATE shared_tasks SET status = 'cancelled' WHERE group_id = $1 AND status <> 'completed'", [groupId]);
    await expect(remove()).resolves.toEqual({ groupId });
    expect((await database().query("SELECT count(*)::int AS n FROM telegram_groups WHERE id = $1", [groupId])).rows[0]!.n).toBe(0);
  });

  it("tells the owner registering from private chat that the group runs without a family, not that it is another family's", async () => {
    const familyId = await family("a", "9101", "9102");
    await database().query(
      `INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, message_mode, enabled_by_telegram_user_id, monthly_budget_usd)
       VALUES(NULL,'-100117','free','external','addressed_only','9301',1)`);
    const owner = await database().query<{ id: string }>("SELECT id FROM users WHERE telegram_user_id = '9101'");
    const attempt = telegramGroupAdministrationRepository.registerGroup({
      familyId, messageMode: "all", requestedBy: owner.rows[0]!.id, telegramChatId: "-100117",
      title: "free", toolAllowlist: [], type: "family_private",
    });
    await expect(attempt).rejects.toMatchObject({ code: "AGENT_GROUP_REGISTRATION_CONFLICT", message: expect.stringContaining("/stop") });
    await expect(attempt).rejects.not.toMatchObject({ message: expect.stringContaining("другой семье") });
    expect((await database().query("SELECT family_id FROM telegram_groups WHERE telegram_chat_id = '-100117'")).rows[0])
      .toEqual({ family_id: null });
  });

  it("lets a person without a family in through a /family group, but not through other groups or other families", async () => {
    const familyId = await family("a", "9101", "9102");
    await family("b", "9201", "9202");
    await registerFamilyGroupByCommand({ verifier: admin, telegramChatId: "-100115", telegramUserId: "9101", title: "Мы" });
    // Группа, подключённая не командой, никого не впускает.
    await database().query(
      "INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, tool_allowlist, message_mode) VALUES($1,'-100116','Ручная','family_private','{}','addressed_only')",
      [familyId]);
    await expect(autoJoinFamilyGroupMember({ displayName: "Юля", telegramChatId: "-100116", telegramUserId: "9301" }))
      .resolves.toBeNull();
    await expect(autoJoinFamilyGroupMember({ displayName: "Юля", telegramChatId: "-100115", telegramUserId: "9301" }))
      .resolves.toEqual({ ownerTelegramUserId: "9101" });
    expect((await database().query(
      "SELECT m.family_id, m.role FROM family_memberships m JOIN users u ON u.id = m.user_id WHERE u.telegram_user_id = '9301'")).rows)
      .toEqual([{ family_id: familyId, role: "member" }]);
    // Уже состоящий в другой семье остаётся там.
    await expect(autoJoinFamilyGroupMember({ displayName: "Чужой", telegramChatId: "-100115", telegramUserId: "9202" }))
      .resolves.toBeNull();
    expect((await database().query(
      "SELECT count(*)::int AS n FROM family_memberships m JOIN users u ON u.id = m.user_id WHERE u.telegram_user_id = '9202'")).rows[0]!.n).toBe(1);
  });

  it("switches auto-join off and on for the owner only, and reads the startgroup form of the command", async () => {
    await family("a", "9101", "9102");
    await registerFamilyGroupByCommand({ verifier: admin, telegramChatId: "-100117", telegramUserId: "9101", title: "Мы" });
    await expect(registerFamilyGroupByCommand({ verifier: admin, autoJoin: "off", telegramChatId: "-100117", telegramUserId: "9102", title: "" }))
      .resolves.toBe("not_owner");
    await expect(registerFamilyGroupByCommand({ verifier: admin, autoJoin: "off", telegramChatId: "-100117", telegramUserId: "9101", title: "" }))
      .resolves.toBe("auto_off");
    await expect(autoJoinFamilyGroupMember({ displayName: "Юля", telegramChatId: "-100117", telegramUserId: "9301" }))
      .resolves.toBeNull();
    await expect(registerFamilyGroupByCommand({ verifier: admin, autoJoin: "on", telegramChatId: "-100117", telegramUserId: "9101", title: "" }))
      .resolves.toBe("auto_on");
    // off в группе, которая не подключена, ничего не создаёт и говорит об этом.
    await expect(registerFamilyGroupByCommand({ verifier: admin, autoJoin: "off", telegramChatId: "-100118", telegramUserId: "9101", title: "" }))
      .resolves.toBe("not_connected");
    expect((await database().query("SELECT count(*)::int AS n FROM telegram_groups WHERE telegram_chat_id = '-100118'")).rows[0]!.n).toBe(0);
    // Повторный /family не затирает выбранный владельцем переключатель.
    await registerFamilyGroupByCommand({ verifier: admin, autoJoin: "off", telegramChatId: "-100117", telegramUserId: "9101", title: "" });
    await expect(registerFamilyGroupByCommand({ verifier: admin, telegramChatId: "-100117", telegramUserId: "9101", title: "Мы" })).resolves.toBe("already");
    expect((await database().query("SELECT auto_join_members FROM telegram_groups WHERE telegram_chat_id = '-100117'")).rows[0]!.auto_join_members).toBe(false);
    for (const text of ["/family", "/family@shusha_bot", "/family off", "/start@shusha_bot family"]) {
      expect(FAMILY_GROUP_COMMAND_PATTERN.test(text), text).toBe(true);
    }
    for (const text of ["/start", "/family maybe", "family"]) {
      expect(FAMILY_GROUP_COMMAND_PATTERN.test(text), text).toBe(false);
    }
  });

  it("refuses to bind a group whose administrator the owner is not, and leaves nothing behind", async () => {
    await family("a", "9101", "9102");
    await expect(registerFamilyGroupByCommand({ telegramChatId: "-100119", telegramUserId: "9101", title: "Чужая", verifier: notAdmin }))
      .resolves.toBe("not_admin");
    const failing: TelegramGroupAdminVerifier = {
      requireAdministrator: async () => { throw new AppError("AGENT_TELEGRAM_GROUP_ADMIN_CHECK_UNAVAILABLE", "нет связи"); },
    };
    await expect(registerFamilyGroupByCommand({ telegramChatId: "-100119", telegramUserId: "9101", title: "Чужая", verifier: failing }))
      .resolves.toBe("admin_check_failed");
    expect((await database().query("SELECT count(*)::int AS n FROM telegram_groups")).rows[0]!.n).toBe(0);
  });

  it("does not bring a removed person back through the group", async () => {
    const familyId = await family("a", "9101", "9102");
    await registerFamilyGroupByCommand({ verifier: admin, telegramChatId: "-100120", telegramUserId: "9101", title: "Мы" });
    await autoJoinFamilyGroupMember({ displayName: "Юля", telegramChatId: "-100120", telegramUserId: "9301" });
    await database().query(
      "INSERT INTO family_member_bans (family_id, telegram_user_id, display_name) VALUES ($1, '9301', 'Юля')", [familyId]);
    await database().query("DELETE FROM family_memberships WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = '9301')");
    await expect(autoJoinFamilyGroupMember({ displayName: "Юля", telegramChatId: "-100120", telegramUserId: "9301" })).resolves.toBeNull();
    expect((await database().query(
      "SELECT count(*)::int AS n FROM family_memberships m JOIN users u ON u.id = m.user_id WHERE u.telegram_user_id = '9301'")).rows[0]!.n).toBe(0);
  });
});
