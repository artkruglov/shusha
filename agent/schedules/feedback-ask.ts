/**
 * Eve ten-minute tick for the weekly «what gets in the way» question to friend families.
 *
 * Export:
 * - Default schedule; the dispatcher decides whose Saturday afternoon it is right now.
 *
 * The minute is offset from the coach and weekly review ticks so they do not read the same tables at once.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchFeedbackAsks } from "../lib/initiative/feedback-ask-runner.js";

export default defineSchedule({
  cron: "9-59/10 * * * *",
  run({ waitUntil }) {
    waitUntil(dispatchFeedbackAsks().catch((error: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_FEEDBACK_ASK_SCHEDULE_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }));
  },
});
