/**
 * Consolidated personal notification settings tool.
 *
 * Export:
 * - `notification_settings`: reads or updates timezone, quiet hours and what the bot sends on its own.
 *
 * Key constructs:
 * - Object-shaped model schema publishes a required finite action discriminator.
 * - One semantic parser validates both approval and execution inputs.
 * - Input validation explains the exact quiet-hours contract before repository calls.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { groupOverviewRepository } from "../initiative/group-overview-repository.js";
import { DAILY_OVERVIEW_DEFAULT_HOUR, dailyOverviewSettings } from "../task-buttons/digest-settings.js";
import { requireReminderAuthorization } from "../reminders/reminder-context.js";
import { reminderRepository } from "../reminders/reminder-repository.js";
import {
  requireAction,
  requiredString,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID";
const TOOL_ACTIONS = ["get", "set", "coach", "weekly_review", "group_overview", "daily_overview"] as const;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const TOP_LEVEL_FIELDS = ["action", "coachEnabled", "dailyOverviewEnabled", "dailyOverviewHour", "groupOverviewEnabled",
  "initiativeDailyLimit", "initiativeEnabled", "quietEnd", "quietStart", "timezone", "weeklyReviewEnabled"] as const;
/** Same bounds as `user_notification_settings.daily_overview_hour` (migration 180). */
const DAILY_OVERVIEW_HOURS = { max: 12, min: 5 } as const;

const nullableTimeSchema = z.union([z.string(), z.null()]).optional();
const notificationSettingsSchema = z.object({
  action: z.enum(TOOL_ACTIONS).describe("Обязательный action."),
  coachEnabled: z.boolean().optional()
    .describe("Обязательно для action=coach: true по явному «да» на приглашение коуча, false на «без коуча»."),
  dailyOverviewEnabled: z.boolean().optional()
    .describe("Обязательно для action=daily_overview: false на «не присылай утреннюю сводку», true чтобы вернуть."),
  dailyOverviewHour: z.number().optional()
    .describe("Необязательно для action=daily_overview: час сводки по местному времени, 5-12."),
  groupOverviewEnabled: z.boolean().optional()
    .describe("Обязательно для action=group_overview: false на «не присылайте общий обзор в группу», true чтобы вернуть."),
  weeklyReviewEnabled: z.boolean().optional()
    .describe("Обязательно для action=weekly_review: true по явной просьбе о недельном обзоре, false на «хватит обзоров»."),
  quietEnd: nullableTimeSchema.describe("Обязательно для action=set: ЧЧ:ММ или null."),
  quietStart: nullableTimeSchema.describe("Обязательно для action=set: ЧЧ:ММ или null."),
  timezone: z.string().optional().describe("Обязательный IANA timezone только для action=set."),
  initiativeEnabled: z.boolean().optional()
    .describe("Необязательно для action=set: false означает «не пиши мне первым»."),
  initiativeDailyLimit: z.number().optional()
    .describe("Необязательно для action=set: сколько раз в сутки можно написать первым, 0-20."),
}).strict();

function requiredNullableTime(input: Record<string, unknown>, key: "quietEnd" | "quietStart"): string | null {
  const value = input[key];
  if (value === null) return null;
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
    toolInputError(
      INPUT_ERROR_CODE,
      `Поле ${key} должно быть null или временем в формате ЧЧ:ММ, например 22:00`,
    );
  }
  return value;
}

function optionalInitiativeLimit(input: Record<string, unknown>): number | undefined {
  const value = input["initiativeDailyLimit"];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 20) {
    toolInputError(INPUT_ERROR_CODE, "Поле initiativeDailyLimit должно быть целым числом от 0 до 20");
  }
  return value;
}

function optionalInitiativeEnabled(input: Record<string, unknown>): boolean | undefined {
  const value = input["initiativeEnabled"];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    toolInputError(INPUT_ERROR_CODE, "Поле initiativeEnabled должно быть true или false");
  }
  return value;
}

function requireSetInput(input: Record<string, unknown>) {
  requireOnlyFields(input, TOP_LEVEL_FIELDS, "action=set", INPUT_ERROR_CODE);
  const quietStart = requiredNullableTime(input, "quietStart");
  const quietEnd = requiredNullableTime(input, "quietEnd");
  const bothDisabled = quietStart === null && quietEnd === null;
  const bothConfigured = quietStart !== null && quietEnd !== null && quietStart !== quietEnd;
  if (!bothDisabled && !bothConfigured) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Передайте quietStart и quietEnd вместе разными значениями ЧЧ:ММ либо оба null, чтобы отключить тихие часы",
    );
  }
  return {
    ...(optionalInitiativeEnabled(input) === undefined
      ? {} : { initiativeEnabled: optionalInitiativeEnabled(input) }),
    ...(optionalInitiativeLimit(input) === undefined
      ? {} : { initiativeDailyLimit: optionalInitiativeLimit(input) }),
    quietEnd,
    quietStart,
    timezone: requiredString(input, "timezone", INPUT_ERROR_CODE, "Europe/Moscow", { maxLength: 100 }),
  };
}

function requireNotificationSettingsInput(input: unknown) {
  const payload = requireInputRecord(input, "notification_settings", INPUT_ERROR_CODE);
  requireOnlyFields(payload, TOP_LEVEL_FIELDS, "notification_settings", INPUT_ERROR_CODE);
  const action = requireAction(payload, "notification_settings", TOOL_ACTIONS, INPUT_ERROR_CODE);

  // MiniMax may materialize known set-only siblings for get. The read action ignores them and
  // cannot turn those values into a write; unpublished fields still fail in the global guard.
  if (action === "get") return { action } as const;
  if (action === "coach") {
    requireOnlyFields(payload, ["action", "coachEnabled"], "action=coach", INPUT_ERROR_CODE);
    if (typeof payload["coachEnabled"] !== "boolean") {
      toolInputError(INPUT_ERROR_CODE, "Для action=coach передайте coachEnabled true или false");
    }
    return { action, enabled: payload["coachEnabled"] as boolean } as const;
  }
  if (action === "weekly_review") {
    requireOnlyFields(payload, ["action", "weeklyReviewEnabled"], "action=weekly_review", INPUT_ERROR_CODE);
    if (typeof payload["weeklyReviewEnabled"] !== "boolean") {
      toolInputError(INPUT_ERROR_CODE, "Для action=weekly_review передайте weeklyReviewEnabled true или false");
    }
    return { action, enabled: payload["weeklyReviewEnabled"] as boolean } as const;
  }
  if (action === "daily_overview") {
    requireOnlyFields(payload, ["action", "dailyOverviewEnabled", "dailyOverviewHour"], "action=daily_overview", INPUT_ERROR_CODE);
    if (typeof payload["dailyOverviewEnabled"] !== "boolean") {
      toolInputError(INPUT_ERROR_CODE, "Для action=daily_overview передайте dailyOverviewEnabled true или false");
    }
    const hour = payload["dailyOverviewHour"];
    if (hour !== undefined && (typeof hour !== "number" || !Number.isInteger(hour) ||
        hour < DAILY_OVERVIEW_HOURS.min || hour > DAILY_OVERVIEW_HOURS.max)) {
      toolInputError(INPUT_ERROR_CODE, "Поле dailyOverviewHour должно быть целым часом от 5 до 12");
    }
    return { action, enabled: payload["dailyOverviewEnabled"] as boolean, hour: (hour as number | undefined) ?? null } as const;
  }
  if (action === "group_overview") {
    requireOnlyFields(payload, ["action", "groupOverviewEnabled"], "action=group_overview", INPUT_ERROR_CODE);
    if (typeof payload["groupOverviewEnabled"] !== "boolean") {
      toolInputError(INPUT_ERROR_CODE, "Для action=group_overview передайте groupOverviewEnabled true или false");
    }
    return { action, enabled: payload["groupOverviewEnabled"] as boolean } as const;
  }
  return { action, values: requireSetInput(payload) } as const;
}

const TOOL_DESCRIPTION = [
  "Личный IANA timezone, тихие часы и то, что бот пишет сам. В тихие часы не приходит ничего начатого без просьбы: ни напоминание, ни сводка, ни предупреждение; отложенное уходит после них. Get: {\"action\":\"get\"}. Set: {\"action\":\"set\",\"timezone\":\"Europe/Moscow\",\"quietStart\":\"22:00\",\"quietEnd\":\"08:00\"}; часы разные ЧЧ:ММ, отключить: оба null; «не пиши мне первым» это initiativeEnabled false, число сообщений в сутки initiativeDailyLimit; непереданное не меняется. Не угадывай timezone и часы, спроси. Coach: coachEnabled false на «без коуча», true только на просьбу вернуть. Weekly_review: {\"action\":\"weekly_review\",\"weeklyReviewEnabled\":true} по просьбе о недельном обзоре (воскресенье вечером), false на «хватит обзоров». Daily_overview: личная утренняя сводка дел, dailyOverviewEnabled false на «не присылай сводку», true с dailyOverviewHour на «присылай в 9». Group_overview: groupOverviewEnabled false только владелец, на «не присылайте общий обзор в группу»; true возвращает.",
].join(" ");

export default defineTool({
  approval: ({ toolInput }) => {
    const parsed = requireNotificationSettingsInput(toolInput);
    // Коуч, обзоры и сводка меняют только то, пишет ли бот сам, и выключаются
    // одной фразой; кнопка подтверждения на такую настройку была бы лишним шагом.
    return parsed.action === "set" ? "user-approval" : "not-applicable";
  },
  description: TOOL_DESCRIPTION,
  inputSchema: notificationSettingsSchema,
  async execute(input, ctx) {
    const parsed = requireNotificationSettingsInput(input);
    const authorization = requireReminderAuthorization(ctx);
    if (authorization.telegramChatType !== "private") {
      throw new AppError(
        "AGENT_NOTIFICATION_SETTINGS_PRIVATE_ONLY",
        "Настройки уведомлений доступны только в личном чате",
      );
    }
    if (parsed.action === "get") {
      const overview = await dailyOverviewSettings.read(authorization.userId);
      return {
        ...await reminderRepository.getNotificationSettings(authorization),
        dailyOverviewEnabled: overview.enabled,
        dailyOverviewHour: overview.hour ?? DAILY_OVERVIEW_DEFAULT_HOUR,
      };
    }
    if (parsed.action === "daily_overview") {
      // The person's own row only: the user id comes from the verified turn, as for the «Сводка» buttons.
      await dailyOverviewSettings.write({
        familyId: authorization.familyId,
        setting: { enabled: parsed.enabled, hour: parsed.hour },
        userId: authorization.userId,
      });
      const overview = await dailyOverviewSettings.read(authorization.userId);
      return { dailyOverviewEnabled: overview.enabled, dailyOverviewHour: overview.hour ?? DAILY_OVERVIEW_DEFAULT_HOUR };
    }
    if (parsed.action === "coach") {
      return await reminderRepository.setCoach(authorization, parsed.enabled);
    }
    if (parsed.action === "weekly_review") {
      return await reminderRepository.setWeeklyReview(authorization, parsed.enabled);
    }
    if (parsed.action === "group_overview") {
      // Общий разбор идёт в семейную группу, то есть касается обоих: гасит и возвращает его владелец.
      if (authorization.role !== "owner") {
        throw new AppError(
          "AGENT_GROUP_OVERVIEW_OWNER_ONLY",
          "Общий утренний обзор в группе включает и выключает только владелец семьи",
        );
      }
      const groups = await groupOverviewRepository.setEnabled(authorization.familyId, parsed.enabled);
      return { groupOverviewEnabled: parsed.enabled, groups };
    }

    return await reminderRepository.configureNotifications(authorization, parsed.values);
  },
});
