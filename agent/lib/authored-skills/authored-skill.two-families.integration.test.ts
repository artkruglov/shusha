/**
 * Две разные семьи: навыки, примеры и выданные группам права одной семьи недоступны владельцу другой.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import type { FamilyCaller } from "../family-context.js";
import { createTwoFamilies, TWO_FAMILIES_TRUNCATE, type TwoFamilies } from "../two-families-fixture.js";
import { authoredSkillExampleRepository as examples } from "./authored-skill-example-repository.js";
import { authoredSkillGrantRepository as grants } from "./authored-skill-grant-repository.js";
import { authoredSkillRepository as skills } from "./authored-skill-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

const KNOWN = new Set(["generate_image", "send_workspace_file", "web_search"]);
const MARKDOWN = [
  "## Когда применять", "Когда просят открытку.",
  "## Шаги", "1. Вызови `web_search`.",
  "## Проверка результата", "Картинка без текста.",
].join("\n");
const provenance = { eveSessionId: "eve-two-families", eveTurnId: "turn-two-families" };

function draft(name: string, marker: string) {
  return {
    changeNote: "Первая версия", description: `Секретный навык ${marker}`, files: {},
    markdown: `${MARKDOWN}\n${marker}`, name, trialSummary: "Пробный прогон.",
  };
}

let f: TwoFamilies;
let ownerA: FamilyCaller;
let ownerB: FamilyCaller;

dbDescribe("two families: authored skills", () => {
  beforeEach(async () => {
    await database().query(TWO_FAMILIES_TRUNCATE);
    f = await createTwoFamilies();
    ownerA = { familyId: f.a.familyId, role: "owner", userId: f.a.owner.userId };
    ownerB = { familyId: f.b.familyId, role: "owner", userId: f.b.owner.userId };
  });
  afterAll(closeDatabase);

  it("does not list, read, resolve or mutate family A's skill from family B", async () => {
    await skills.publish(ownerA, draft("secret-skill", "SECRET-A"), { knownToolNames: KNOWN, operationKey: "a-1", provenance });
    expect(await skills.list(f.b.familyId)).toEqual([]);
    expect(await skills.activePackages(f.b.familyId)).toEqual([]);
    expect(await skills.isAuthoredSkill(f.b.familyId, "secret-skill")).toBe(false);
    await expect(skills.read(f.b.familyId, "secret-skill")).rejects.toThrow(/AGENT_SKILL_/);
    await expect(skills.retire(ownerB, { name: "secret-skill" })).rejects.toThrow(/AGENT_SKILL_/);
    await expect(skills.rollback(ownerB, {
      knownToolNames: KNOWN, name: "secret-skill", operationKey: "b-rb", provenance, version: 1,
    })).rejects.toThrow(/AGENT_SKILL_/);
    // Подделка: владелец семьи A под familyId семьи B ничего не получает от семьи A и ничего не меняет.
    await expect(skills.retire({ familyId: f.b.familyId, role: "owner", userId: f.a.owner.userId },
      { name: "secret-skill" })).rejects.toThrow(/AGENT_SKILL_/);
    // Одноимённый навык семьи B независим: это версия 1, а не версия 2 чужого навыка.
    await expect(skills.publish(ownerB, draft("secret-skill", "OWN-B"), { knownToolNames: KNOWN, operationKey: "a-1", provenance }))
      .resolves.toMatchObject({ replayed: false, version: 1 });
    expect((await skills.read(f.a.familyId, "secret-skill")).markdown).toContain("SECRET-A");
    expect((await skills.read(f.b.familyId, "secret-skill")).markdown).not.toContain("SECRET-A");
    expect(await skills.list(f.a.familyId)).toEqual([expect.objectContaining({ name: "secret-skill", version: 1 })]);
    const status = await database().query("SELECT family_id, status FROM authored_skills ORDER BY family_id");
    expect(status.rows.every((row) => row.status === "active")).toBe(true);
  });

  it("does not expose or change family A's examples from family B", async () => {
    await skills.publish(ownerA, draft("secret-skill", "SECRET-A"), { knownToolNames: KNOWN, operationKey: "a-1", provenance });
    const example = await examples.add(ownerA, { expected: "Открытка", name: "secret-skill", request: "Сделай открытку" });
    expect(await examples.list(f.b.familyId, "secret-skill")).toEqual([]);
    await expect(examples.add(ownerB, { expected: "x", name: "secret-skill", request: "y" })).rejects.toThrow(/AGENT_SKILL_/);
    await expect(examples.remove(ownerB, { exampleId: example!.id, name: "secret-skill" })).rejects.toThrow(/AGENT_SKILL_/);
    expect(await examples.list(f.a.familyId, "secret-skill")).toEqual([expect.objectContaining({ id: example.id })]);
  });

  it("does not let family B grant, revoke or resolve family A's skill and groups", async () => {
    await skills.publish(ownerA, draft("secret-skill", "SECRET-A"), { knownToolNames: KNOWN, operationKey: "a-1", provenance });
    const groupA = (await database().query<{ id: string }>(
      `INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES ($1, '-1001111', 'Клуб A', 'external', 'addressed_only', '{web_search}') RETURNING id`, [f.a.familyId])).rows[0]!.id;
    const groupB = (await database().query<{ id: string }>(
      `INSERT INTO telegram_groups(family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES ($1, '-1002222', 'Клуб B', 'external', 'addressed_only', '{web_search}') RETURNING id`, [f.b.familyId])).rows[0]!.id;
    await grants.grant(ownerA, { group: "-1001111", name: "secret-skill" });

    // Чужая группа по chat id и название чужого навыка в своей группе.
    await expect(grants.grant(ownerB, { group: "-1001111", name: "secret-skill" })).rejects.toThrow(/AGENT_SKILL_GROUP_NOT_FOUND/);
    await expect(grants.grant(ownerB, { group: "-1002222", name: "secret-skill" })).rejects.toThrow(/AGENT_SKILL_NOT_FOUND/);
    await expect(grants.revoke(ownerB, { group: "-1001111", name: "secret-skill" })).rejects.toThrow(/AGENT_SKILL_GROUP_NOT_FOUND/);
    await expect(grants.revoke(ownerB, { group: "-1002222", name: "secret-skill" })).rejects.toThrow(/AGENT_SKILL_GRANT_NOT_FOUND/);
    expect(await grants.grants(f.b.familyId)).toEqual([]);
    // Резолвер пакетов группы и чтение выданного markdown сверяют семью.
    expect(await grants.packagesForGroup({ familyId: f.b.familyId, groupId: groupA })).toEqual([]);
    expect(await grants.grantedMarkdown({ familyId: f.b.familyId, groupId: groupA, name: "secret-skill" })).toBeNull();
    expect(await grants.packagesForGroup({ familyId: f.a.familyId, groupId: groupB })).toEqual([]);
    expect(await grants.packagesForGroup({ familyId: f.a.familyId, groupId: groupA })).toHaveLength(1);
    expect(await grants.grants(f.a.familyId)).toEqual([expect.objectContaining({ name: "secret-skill", telegramChatId: "-1001111" })]);
  });

  it("records an owner outcome only for the caller's own family", async () => {
    await skills.publish(ownerA, draft("secret-skill", "SECRET-A"), { knownToolNames: KNOWN, operationKey: "a-1", provenance });
    const conversation = (await database().query<{ id: string }>(
      "SELECT id FROM application_conversations WHERE telegram_group_id = $1", [f.a.groupId])).rows[0]!.id;
    await expect(skills.recordUsage({
      conversationId: conversation, eveSessionId: "s", eveTurnId: "t", familyId: f.a.familyId, skillName: "secret-skill",
    })).resolves.toBe(true);
    // Семья B не записывает использование чужого навыка и не меняет исход чужого использования.
    await expect(skills.recordUsage({
      conversationId: conversation, eveSessionId: "s", eveTurnId: "t", familyId: f.b.familyId, skillName: "secret-skill",
    })).resolves.toBe(false);
    await expect(skills.recordOutcome({ familyId: f.b.familyId }, {
      conversationId: conversation, name: "secret-skill", note: null, outcome: "failed", source: "owner",
    })).resolves.toMatchObject({ usageFound: false });
    expect((await database().query("SELECT outcome FROM authored_skill_usage")).rows).toEqual([{ outcome: "unknown" }]);
  });
});
