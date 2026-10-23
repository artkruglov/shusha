/**
 * The morning overview's own switch and hour, set with buttons (migration 180).
 *
 * Exports:
 * - `DailyOverviewSetting`: on or off, and the hour (null keeps the default).
 * - `DIGEST_HOURS`, `DAILY_OVERVIEW_DEFAULT_HOUR`: the hours the buttons offer and the hour without a choice.
 * - `digestSettingsText`, `digestSettingsKeyboard`: the settings message and its buttons.
 * - `dailyOverviewSettings`: reads and writes the person's own row.
 *
 * Until now the only switch was `initiative_enabled`, which silences every message the bot starts.
 * «Сводка» under the overview opens this message; an hour button turns the overview on at that hour and
 * «Выключить» turns only the overview off. Quiet hours and the initiative switch still win. Each person
 * changes only their own row: the user id comes from the presser's live identity, never from the button.
 */
import type { PoolClient } from "pg";

import { database } from "../database.js";
import type { OverviewReplyMarkup } from "./overview-keyboard.js";
import { taskButtonCallbackData } from "./task-button-callback-data.js";
import { taskButtonRepository } from "./task-button-repository.js";

export interface DailyOverviewSetting {
  enabled: boolean;
  hour: number | null;
}

export const DIGEST_HOURS = [7, 8, 9, 10] as const;
/** Same as `DAILY_OVERVIEW_LOCAL_HOUR`; repeated here to keep the dispatcher free of this module. */
export const DAILY_OVERVIEW_DEFAULT_HOUR = 8;

export function digestSettingsText(setting: DailyOverviewSetting): string {
  return setting.enabled
    ? `Утренняя сводка приходит в ${setting.hour ?? DAILY_OVERVIEW_DEFAULT_HOUR}:00 по твоему времени.`
    : "Утренняя сводка выключена. Выбери время, чтобы включить.";
}

export async function digestSettingsKeyboard(input: {
  chatId: string;
  familyId: string;
  now: Date;
  setting: DailyOverviewSetting;
}): Promise<OverviewReplyMarkup> {
  const ids = await taskButtonRepository.create({
    chatId: input.chatId,
    familyId: input.familyId,
    items: [
      ...DIGEST_HOURS.map((hour) => ({ action: "digest_hour" as const, value: hour })),
      ...(input.setting.enabled ? [{ action: "digest_off" as const }] : []),
    ],
    now: input.now,
    recipientTelegramId: input.chatId,
  });
  const current = input.setting.enabled ? input.setting.hour ?? DAILY_OVERVIEW_DEFAULT_HOUR : null;
  return {
    inline_keyboard: [
      DIGEST_HOURS.map((hour, index) => ({
        callback_data: taskButtonCallbackData(ids[index]!),
        text: hour === current ? `• ${hour}:00` : `${hour}:00`,
      })),
      ...(input.setting.enabled ? [[{ callback_data: taskButtonCallbackData(ids.at(-1)!), text: "Выключить" }]] : []),
    ],
  };
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const dailyOverviewSettings = {
  async read(userId: string): Promise<DailyOverviewSetting> {
    const result = await database().query<{ daily_overview_enabled: boolean; daily_overview_hour: number | null }>(
      "SELECT daily_overview_enabled, daily_overview_hour FROM user_notification_settings WHERE user_id = $1",
      [userId],
    );
    const row = result.rows[0];
    return row ? { enabled: row.daily_overview_enabled, hour: row.daily_overview_hour } : { enabled: true, hour: null };
  },

  /**
   * The row may not exist yet (people who never named a timezone): it is created with the owner's
   * timezone, as the coach and weekly review consents do (`reminder-repository.ts`).
   */
  async write(input: { familyId: string; setting: DailyOverviewSetting; userId: string }): Promise<void> {
    await inTransaction(async (client) => {
      await client.query(
        `INSERT INTO user_notification_settings(user_id, timezone, daily_overview_enabled, daily_overview_hour)
         VALUES ($1, COALESCE((SELECT settings.timezone FROM user_notification_settings AS settings
                                 JOIN family_memberships AS membership ON membership.user_id = settings.user_id
                                WHERE membership.family_id = $2 AND membership.role = 'owner'), 'UTC'), $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET daily_overview_enabled = EXCLUDED.daily_overview_enabled,
           daily_overview_hour = COALESCE(EXCLUDED.daily_overview_hour, user_notification_settings.daily_overview_hour),
           updated_at = now()`,
        [input.userId, input.familyId, input.setting.enabled, input.setting.hour],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, metadata)
         VALUES ($1, $2, 'notifications.daily_overview',
                 jsonb_build_object('enabled', $3::boolean, 'hour', $4::integer))`,
        [input.familyId, input.userId, input.setting.enabled, input.setting.hour],
      );
    });
  },
};
