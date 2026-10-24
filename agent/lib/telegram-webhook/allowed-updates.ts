/**
 * The update types the bot subscribes to, shared by the installer and the running agent.
 *
 * Exports:
 * - `TELEGRAM_WEBHOOK_PATH`: the path of the verified webhook route.
 * - `TELEGRAM_ALLOWED_UPDATES`: every update type the application handles.
 *
 * Telegram delivers only the types named in `allowed_updates`, and a `setWebhook` without the field keeps
 * the previous list (Bot API 10.3, `setWebhook`). A type the application handles but the list misses is
 * lost in silence, so the list lives in one place: `my_chat_member` (the bot blocked or unblocked in a
 * private chat, removed from or added to a group) joined it on 24 October 2026.
 */
export const TELEGRAM_WEBHOOK_PATH = "/eve/v1/telegram";

export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "guest_message",
  "chat_join_request",
  "my_chat_member",
] as const;
