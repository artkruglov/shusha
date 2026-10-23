/**
 * Callback data of the «Напомнить и мне» button under a guest answer.
 *
 * Exports:
 * - `GUEST_REMINDER_CALLBACK_PREFIX`: the prefix the guest answer writes and the callback handler reads.
 * - `parseGuestReminderCallbackData`: the offer id of a press, or null for any other button.
 */
export const GUEST_REMINDER_CALLBACK_PREFIX = "gr:";

const PATTERN = /^gr:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

export function parseGuestReminderCallbackData(data: string | undefined): string | null {
  return data?.match(PATTERN)?.[1] ?? null;
}
