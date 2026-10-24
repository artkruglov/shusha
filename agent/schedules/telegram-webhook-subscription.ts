/**
 * Eve check, every ten minutes, that Telegram sends the bot every update type it handles.
 *
 * Export:
 * - Default schedule; writes to Telegram only when `allowed_updates` differs from the application's list,
 *   so the first tick after a deploy subscribes a running installation to a new type.
 */
import { defineSchedule } from "eve/schedules";

import { ensureTelegramWebhookSubscription } from "../lib/telegram-webhook/webhook-subscription.js";

export default defineSchedule({
  cron: "*/10 * * * *",
  run({ waitUntil }) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
    if (!botToken || !secretToken) return;
    waitUntil(ensureTelegramWebhookSubscription({ botToken, secretToken }).then((outcome) => {
      if (outcome === "unchanged") return;
      const log = outcome === "updated" ? console.info : console.warn;
      log(JSON.stringify({ code: "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_CHECKED", outcome }));
    }).catch((error: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_FAILED",
        errorCode: error instanceof Error && "code" in error ? String(error.code) : null,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }));
    }));
  },
});
