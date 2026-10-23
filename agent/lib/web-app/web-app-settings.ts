/**
 * «Утренняя сводка» в Mini App: сводка и её час, тихие часы, недельный обзор, коуч и «писать мне первым».
 *
 * Exports:
 * - `WebAppSettings`, `WebAppSettingsChange`: то, что видит и присылает страница.
 * - `privateReminderAuthorization`: права лички для репозиториев напоминаний и расписаний.
 * - `parseSettingsChange`: проверка присланного; неверное поле это 400, а не тихая подмена.
 * - `webAppSettings`: чтение и сохранение через те же репозитории, что инструмент `notification_settings`
 *   и кнопки сводки (`task-buttons/digest-settings.ts`).
 *
 * Нажатие «Сохранить» в приложении это явное действие проверенного человека над его собственной строкой,
 * поэтому подтверждения кнопкой, как у инструмента в чате, здесь нет. Пояс в приложении не меняется: его
 * человек называет в чате, а страница только показывает. Коуч без ответа на приглашение (`null`) остаётся
 * `null`, пока человек сам не переключит его здесь.
 */
import { AppError } from "../app-error.js";
import { currentTimeRepository } from "../current-time-repository.js";
import type { MemoryAuthorization } from "../memory-context.js";
import type { ReminderAuthorization } from "../reminders/reminder-context.js";
import { reminderRepository } from "../reminders/reminder-repository.js";
import { database } from "../database.js";
import { writeDefaultTaskVisibility, type TaskVisibility } from "../shared-task-visibility.js";
import { DAILY_OVERVIEW_DEFAULT_HOUR, dailyOverviewSettings } from "../task-buttons/digest-settings.js";

const HOUR_MIN = 5;
const HOUR_MAX = 12;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/u;

export interface WebAppSettings {
  readonly overview: { readonly enabled: boolean; readonly hour: number };
  readonly hours: readonly number[];
  readonly timezone: string;
  readonly quietStart: string | null;
  readonly quietEnd: string | null;
  readonly weeklyReview: boolean;
  readonly coach: boolean | null;
  readonly initiative: boolean;
  /** Who sees a new task written in the private chat; null until the person chose (`shared-task-visibility.ts`). */
  readonly defaultVisibility: TaskVisibility | null;
}

export interface WebAppSettingsChange {
  readonly overview: { readonly enabled: boolean; readonly hour: number };
  readonly quietStart: string | null;
  readonly quietEnd: string | null;
  readonly weeklyReview: boolean;
  readonly coach?: boolean;
  readonly initiative: boolean;
  readonly defaultVisibility?: TaskVisibility;
}

export function privateReminderAuthorization(auth: MemoryAuthorization): ReminderAuthorization & { telegramUserId: string } {
  if (auth.userId === null || auth.telegramUserId === null) throw new AppError("AGENT_ACCESS_DENIED", "Нет доступа");
  return {
    ...(auth.space ? { space: auth.space } : {}),
    familyId: auth.familyId, forumTopicId: null, groupId: null, groupType: null, messageThreadId: null,
    role: auth.role as ReminderAuthorization["role"],
    // In a private chat the chat is the person.
    telegramChatId: auth.telegramUserId, telegramChatType: "private", telegramUserId: auth.telegramUserId,
    userId: auth.userId,
  };
}

function invalid(): never {
  throw new AppError("AGENT_WEB_APP_BAD_REQUEST", "Неверные настройки");
}

export function parseSettingsChange(body: Record<string, unknown>): WebAppSettingsChange {
  const overview = body.overview as { enabled?: unknown; hour?: unknown } | undefined;
  if (typeof overview !== "object" || overview === null || typeof overview.enabled !== "boolean") invalid();
  const hour = overview.hour;
  if (typeof hour !== "number" || !Number.isInteger(hour) || hour < HOUR_MIN || hour > HOUR_MAX) invalid();
  const time = (value: unknown) => {
    if (value === null) return null;
    if (typeof value !== "string" || !TIME.test(value)) invalid();
    return value;
  };
  const quietStart = time(body.quietStart);
  const quietEnd = time(body.quietEnd);
  // Both or neither, and not the same minute: the repository's rule, checked here for a clear 400.
  if ((quietStart === null) !== (quietEnd === null) || (quietStart !== null && quietStart === quietEnd)) invalid();
  if (typeof body.weeklyReview !== "boolean" || typeof body.initiative !== "boolean") invalid();
  if (body.coach !== undefined && typeof body.coach !== "boolean") invalid();
  if (body.defaultVisibility !== undefined && body.defaultVisibility !== "family" && body.defaultVisibility !== "personal") invalid();
  return {
    initiative: body.initiative, overview: { enabled: overview.enabled, hour }, quietEnd, quietStart,
    weeklyReview: body.weeklyReview, ...(body.coach === undefined ? {} : { coach: body.coach as boolean }),
    ...(body.defaultVisibility === undefined ? {} : { defaultVisibility: body.defaultVisibility as TaskVisibility }),
  };
}

export const webAppSettings = {
  async read(auth: MemoryAuthorization): Promise<WebAppSettings> {
    const reminderAuth = privateReminderAuthorization(auth);
    const overview = await dailyOverviewSettings.read(reminderAuth.userId);
    const visibility = await database().query<{ default_task_visibility: TaskVisibility | null }>(
      "SELECT default_task_visibility FROM user_notification_settings WHERE user_id = $1", [reminderAuth.userId]);
    let view;
    try {
      view = await reminderRepository.getNotificationSettings(reminderAuth);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "AGENT_NOTIFICATION_SETTINGS_REQUIRED") throw error;
      // No row yet: the person hears the bot in the family owner's zone, as the overview does.
      view = null;
    }
    return {
      coach: view?.coachEnabled ?? null,
      defaultVisibility: visibility.rows[0]?.default_task_visibility ?? null,
      hours: Array.from({ length: HOUR_MAX - HOUR_MIN + 1 }, (_, index) => HOUR_MIN + index),
      initiative: view?.initiativeEnabled ?? true,
      overview: { enabled: overview.enabled, hour: overview.hour ?? DAILY_OVERVIEW_DEFAULT_HOUR },
      quietEnd: view?.quietEnd ?? null,
      quietStart: view?.quietStart ?? null,
      timezone: view?.timezone ?? await currentTimeRepository.findTurnTimezone(reminderAuth.userId, auth.familyId) ?? "UTC",
      // The weekly review is on until the person says stop (30 September 2026).
      weeklyReview: view?.weeklyReviewEnabled !== false,
    };
  },

  async save(auth: MemoryAuthorization, change: WebAppSettingsChange): Promise<WebAppSettings> {
    const reminderAuth = privateReminderAuthorization(auth);
    const current = await this.read(auth);
    await reminderRepository.configureNotifications(reminderAuth, {
      initiativeEnabled: change.initiative, quietEnd: change.quietEnd, quietStart: change.quietStart,
      timezone: current.timezone,
    });
    await dailyOverviewSettings.write({ familyId: auth.familyId, setting: change.overview, userId: reminderAuth.userId });
    if (change.weeklyReview !== current.weeklyReview) await reminderRepository.setWeeklyReview(reminderAuth, change.weeklyReview);
    if (change.coach !== undefined && change.coach !== current.coach) await reminderRepository.setCoach(reminderAuth, change.coach);
    if (change.defaultVisibility !== undefined && change.defaultVisibility !== current.defaultVisibility) {
      await writeDefaultTaskVisibility({ familyId: auth.familyId, userId: reminderAuth.userId, visibility: change.defaultVisibility });
    }
    return this.read(auth);
  },
};
