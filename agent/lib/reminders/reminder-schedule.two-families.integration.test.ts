/**
 * Две разные семьи не читают и не меняют напоминания, расписания и настройки уведомлений друг друга,
 * даже если знают id чужой записи.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { agentScheduleRepository } from "../agent-schedules/agent-schedule-repository.js";
import { closeDatabase, database } from "../database.js";
import { createTwoFamilies, scheduleAuth, TWO_FAMILIES_TRUNCATE, type TwoFamilies } from "../two-families-fixture.js";
import { reminderRepository } from "./reminder-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let f: TwoFamilies;
const NOW = new Date("2030-01-01T06:00:00.000Z");

async function settings(fixture: TwoFamilies["a"]) {
  for (const person of [fixture.owner, fixture.spouse]) {
    await reminderRepository.configureNotifications(scheduleAuth(fixture, person, "private"), {
      quietEnd: null, quietStart: null, timezone: "Europe/Moscow",
    });
  }
}

dbDescribe("two families: reminders, schedules, notification settings", () => {
  beforeEach(async () => {
    await database().query(TWO_FAMILIES_TRUNCATE);
    f = await createTwoFamilies();
    await settings(f.a);
    await settings(f.b);
  });
  afterAll(closeDatabase);

  for (const scope of ["personal", "family"] as const) {
    it(`hides a ${scope} reminder of family A from family B and keeps it unchanged`, async () => {
      const chat = scope === "family" ? "group" : "private";
      const authA = scheduleAuth(f.a, f.a.owner, chat);
      const reminder = await reminderRepository.create(authA, {
        content: "Секрет семьи A", firstRunAt: NOW, operationKey: `create-${scope}`,
        recurrence: null, scope, timezone: "Europe/Moscow",
      });
      const attackers = [
        scheduleAuth(f.b, f.b.owner, chat), scheduleAuth(f.b, f.b.owner, "private"),
        scheduleAuth(f.b, f.b.owner, "group"),
        // Подделка: семья B, но пользователь семьи A.
        { ...scheduleAuth(f.b, f.a.owner, chat), role: "owner" as const },
      ];
      for (const [index, attacker] of attackers.entries()) {
        const page = await reminderRepository.list(attacker, { limit: 100 });
        expect(page.items.map((item) => item.id)).not.toContain(reminder.id);
        await expect(reminderRepository.update(attacker, reminder.id,
          { content: "Взломано", operationKey: `upd-${scope}-${index}` })).rejects.toThrow();
        await expect(reminderRepository.delete(attacker, reminder.id, `del-${scope}-${index}`)).rejects.toThrow();
      }
      const stored = await database().query("SELECT content, status, family_id FROM reminders WHERE id = $1", [reminder.id]);
      expect(stored.rows).toEqual([{ content: "Секрет семьи A", family_id: f.a.familyId, status: "active" }]);
      await expect(reminderRepository.list(authA, { limit: 100 })).resolves.toMatchObject({
        items: [expect.objectContaining({ id: reminder.id, content: "Секрет семьи A" })],
      });
    });
  }

  for (const scope of ["personal", "family"] as const) {
    it(`hides a ${scope} agent schedule of family A from family B (list, findById, update, delete, runNow)`, async () => {
      const chat = scope === "family" ? "group" : "private";
      const authA = scheduleAuth(f.a, f.a.owner, chat);
      const schedule = await agentScheduleRepository.create(authA, {
        firstRunAt: NOW, operationKey: `create-${scope}`, recurrence: { interval: 1, kind: "daily" },
        scenarioPrompt: "Секретный сценарий семьи A.", scope, timezone: "Europe/Moscow",
        title: "Сценарий A", userRequest: "Секретная просьба семьи A",
      });
      const attackers = [
        scheduleAuth(f.b, f.b.owner, chat), scheduleAuth(f.b, f.b.owner, "private"),
        scheduleAuth(f.b, f.b.owner, "group"),
        { ...scheduleAuth(f.b, f.a.owner, chat), role: "owner" as const },
      ];
      for (const [index, attacker] of attackers.entries()) {
        const page = await agentScheduleRepository.list(attacker, { limit: 100 });
        expect(page.items.map((item) => item.id)).not.toContain(schedule.id);
        await expect(agentScheduleRepository.findById(attacker, schedule.id)).resolves.toBeNull();
        await expect(agentScheduleRepository.update(attacker, schedule.id,
          { enabled: false, operationKey: `upd-${scope}-${index}` })).rejects.toThrow(/AGENT_SCHEDULE_/);
        await expect(agentScheduleRepository.delete(attacker, schedule.id, `del-${scope}-${index}`))
          .rejects.toThrow(/AGENT_SCHEDULE_/);
        await expect(agentScheduleRepository.runNow(attacker, schedule.id, `run-${scope}-${index}`))
          .rejects.toThrow(/AGENT_SCHEDULE_/);
      }
      await expect(agentScheduleRepository.findById(authA, schedule.id)).resolves.toEqual(schedule);
    });
  }

  it("keeps notification settings, coach and weekly review switches per person, never per neighbouring family", async () => {
    const ownerA = scheduleAuth(f.a, f.a.owner, "private");
    const ownerB = scheduleAuth(f.b, f.b.owner, "private");
    await reminderRepository.configureNotifications(ownerA, { quietEnd: "07:00", quietStart: "23:00", timezone: "Asia/Tokyo" });
    await reminderRepository.setCoach(ownerA, true);
    await reminderRepository.setWeeklyReview(ownerA, false);

    await expect(reminderRepository.getNotificationSettings(ownerB)).resolves.toMatchObject({ timezone: "Europe/Moscow" });
    const before = await reminderRepository.getNotificationSettings(ownerB);
    await reminderRepository.setCoach(ownerB, false);
    // Попытка семьи B выключить коуча человека из семьи A: идёт под ролью чужой семьи.
    await expect(reminderRepository.setCoach({ ...ownerB, userId: f.a.owner.userId }, false)).rejects.toThrow();
    await expect(reminderRepository.getNotificationSettings(ownerA)).resolves.toMatchObject({
      coachEnabled: true, timezone: "Asia/Tokyo", weeklyReviewEnabled: false,
    });
    await expect(reminderRepository.getNotificationSettings(ownerB)).resolves.toMatchObject({
      timezone: before.timezone, weeklyReviewEnabled: before.weeklyReviewEnabled,
    });
  });
});
