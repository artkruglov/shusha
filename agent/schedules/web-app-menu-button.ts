/**
 * Eve hourly check of the bot's menu button «Дела» (the Mini App board).
 *
 * Export:
 * - Default schedule; writes to Telegram only when the button is missing or points elsewhere.
 */
import { defineSchedule } from "eve/schedules";

import { ensureWebAppMenuButton, webAppUrl } from "../lib/web-app/web-app-menu.js";

export default defineSchedule({
  cron: "17 * * * *",
  run({ waitUntil }) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return;
    waitUntil(ensureWebAppMenuButton({ botToken, url: webAppUrl() }).then((outcome) => {
      if (outcome === "set") console.info(JSON.stringify({ code: "AGENT_WEB_APP_MENU_SET" }));
    }).catch((error: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_WEB_APP_MENU_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
    }));
  },
});
