/**
 * Чтения заявок в группу на настоящей схеме.
 *
 * Constructs covered:
 * - `findGroup` находит только обычную группу семьи и её владельца; семейная группа, группа без семьи и
 *   незнакомый чат дают null.
 * - `isFamilyMember`: участник семьи да, человек другой семьи и исключённый из семьи нет.
 * - Строка приглашения: забирается ровно один раз в нужном состоянии, `release` возвращает вопрос, забытые чистятся.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createTaskFamilyFixture } from "../shared-task.integration-fixtures.js";
import { groupJoinRepository } from "./group-join-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

(enabled ? describe : describe.skip)("group join repository", () => {
  let familyId: string;
  let groupId: string;

  beforeEach(async () => {
    const { owner } = await createTaskFamilyFixture();
    familyId = owner.familyId;
    groupId = (await database().query<{ id: string }>(
      `INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, tool_allowlist, message_mode)
       VALUES($1, '-3001', 'Квартира', 'external', '{}', 'all') RETURNING id`, [familyId])).rows[0]!.id;
    await database().query(
      `INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, tool_allowlist, message_mode,
         enabled_by_telegram_user_id, monthly_budget_usd)
       VALUES(NULL, '-3002', 'Без семьи', 'external', '{}', 'all', '700101', 1)`);
  });
  afterAll(closeDatabase);

  it("finds an ordinary family group with its owner and nothing else", async () => {
    expect(await groupJoinRepository.findGroup("-3001")).toEqual({
      familyId, groupId, ownerName: "Owner", ownerTelegramUserId: "700101", telegramChatId: "-3001", title: "Квартира",
    });
    const family = (await database().query<{ telegram_chat_id: string }>(
      "SELECT telegram_chat_id FROM telegram_groups WHERE family_id = $1 AND type = 'family_private'", [familyId])).rows[0]!;
    expect(await groupJoinRepository.findGroup(family.telegram_chat_id)).toBeNull();
    expect(await groupJoinRepository.findGroup("-3002")).toBeNull();
    expect(await groupJoinRepository.findGroup("-3999")).toBeNull();
  });

  it("knows a family member from a stranger and a banned person", async () => {
    expect(await groupJoinRepository.isFamilyMember(familyId, "700102")).toBe(true);
    expect(await groupJoinRepository.isFamilyMember(familyId, "799999")).toBe(false);
    await database().query("INSERT INTO family_member_bans(family_id, telegram_user_id, display_name) VALUES($1, '700102', 'Member')", [familyId]);
    expect(await groupJoinRepository.isFamilyMember(familyId, "700102")).toBe(false);
  });

  it("takes an invitation once, in the state asked for, and forgets old ones", async () => {
    const group = (await groupJoinRepository.findGroup("-3001"))!;
    expect(await groupJoinRepository.take(groupId, "800", "greeted", null)).toBe(false);
    await groupJoinRepository.greet(group, "800");
    expect(await groupJoinRepository.take(groupId, "800", "asked", null)).toBe(false);
    expect(await groupJoinRepository.take(groupId, "800", "greeted", "asked")).toBe(true);
    expect(await groupJoinRepository.take(groupId, "800", "greeted", "asked")).toBe(false);
    await groupJoinRepository.release(groupId, "800");
    expect(await groupJoinRepository.take(groupId, "800", "greeted", "asked")).toBe(true);
    expect(await groupJoinRepository.take(groupId, "800", "asked", null)).toBe(true);
    expect(await groupJoinRepository.take(groupId, "800", "asked", null)).toBe(false);

    await groupJoinRepository.greet(group, "801");
    await database().query("UPDATE group_join_invitations SET created_at = now() - interval '31 days' WHERE telegram_user_id = '801'");
    await groupJoinRepository.greet(group, "802");
    const left = await database().query<{ telegram_user_id: string }>("SELECT telegram_user_id FROM group_join_invitations");
    expect(left.rows.map((row) => row.telegram_user_id)).toEqual(["802"]);
  });
});
