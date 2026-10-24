/**
 * Eve check, every ten minutes, that Telegram sends the bot every update type it handles.
 *
 * Export:
 * - Default schedule; writes to Telegram only when the webhook at the installation's own URL has another
 *   update list or another fixed IP, so the first tick after a deploy subscribes a running installation
 *   to a new type. An outcome other than «unchanged» is logged when it first appears, not on every tick.
 */
import { defineSchedule } from "eve/schedules";

import { ensureTelegramWebhookSubscription } from "../lib/telegram-webhook/webhook-subscription.js";

let lastOutcome: string | null = null;

export default defineSchedule({
  cron: "*/10 * * * *",
  run({ waitUntil }) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
    if (!botToken || !secretToken) return;
    waitUntil(ensureTelegramWebhookSubscription({
      botToken,
      ...(process.env.TELEGRAM_WEBHOOK_IP_ADDRESS ? { ipAddress: process.env.TELEGRAM_WEBHOOK_IP_ADDRESS } : {}),
      publicBaseUrl: process.env.PUBLIC_BASE_URL,
      secretToken,
    }).then((outcome) => {
      const repeated = outcome === lastOutcome;
      lastOutcome = outcome;
      if (outcome === "unchanged" || (repeated && outcome !== "updated")) return;
      const log = outcome === "updated" ? console.info : console.warn;
      log(JSON.stringify({ code: "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_CHECKED", outcome }));
    }).catch((error: unknown) => {
      lastOutcome = null;
      console.error(JSON.stringify({
        code: "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION_FAILED",
        errorCode: error instanceof Error && "code" in error ? String(error.code) : null,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }));
    }));
  },
});
