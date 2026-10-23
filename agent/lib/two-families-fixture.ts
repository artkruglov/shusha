/**
 * Фикстура двух разных семей в одной установке для тестов изоляции между семьями.
 *
 * Экспорт:
 * - `createTwoFamilies`: две независимые строки `families`, у каждой владелец, участник и семейная группа.
 * - `TWO_FAMILIES_TRUNCATE`: список таблиц для TRUNCATE в `beforeEach`.
 * - `scheduleAuth`: авторизация напоминаний и расписаний (личный чат или семейная группа).
 * - `memoryAuth`: авторизация инструментов с `MemoryAuthorization` (личный чат или семейная группа).
 *
 * Проверка «чужая семья» здесь настоящая: у семей разные строки `families`, разные пользователи и
 * разные группы, а не две области одной семьи.
 */
import { database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { createTwoSpaceFixture, type TwoSpaceFixture } from "./spaces/two-space-fixture.js";

export const TWO_FAMILIES_TRUNCATE = `TRUNCATE reminders, agent_schedules, care_areas, shared_tasks, joint_decisions,
  agent_improvement_items, authored_skills, shopping_items, initiative_messages, user_notification_settings,
  proactive_deliveries, conversation_sessions, application_conversations, spaces, telegram_groups,
  family_memberships, users, families CASCADE`;

export interface TwoFamilies {
  readonly a: TwoSpaceFixture;
  readonly b: TwoSpaceFixture;
}

export async function createTwoFamilies(): Promise<TwoFamilies> {
  const a = await createTwoSpaceFixture("family-a");
  const b = await createTwoSpaceFixture("family-b");
  return { a, b };
}

type Person = TwoSpaceFixture["owner"];

export function scheduleAuth(fixture: TwoSpaceFixture, person: Person, chat: "group" | "private") {
  return {
    familyId: fixture.familyId,
    forumTopicId: null,
    groupId: chat === "group" ? fixture.groupId : null,
    groupType: chat === "group" ? "family_private" as const : null,
    messageThreadId: null,
    role: person === fixture.owner ? "owner" as const : "member" as const,
    telegramChatId: chat === "group" ? fixture.telegramChatId : person.telegramUserId,
    telegramChatType: chat === "group" ? "supergroup" as const : "private" as const,
    telegramUserId: person.telegramUserId,
    userId: person.userId,
  };
}

export function memoryAuth(fixture: TwoSpaceFixture, person: Person, chat: "group" | "private"): MemoryAuthorization {
  return {
    familyId: fixture.familyId,
    groupId: chat === "group" ? fixture.groupId : null,
    role: "member",
    scopes: chat === "group" ? ["family"] : ["personal", "family"],
    telegramActorId: person.telegramUserId,
    telegramActorKind: "telegram_user",
    telegramUserId: person.telegramUserId,
    userId: person.userId,
  };
}
