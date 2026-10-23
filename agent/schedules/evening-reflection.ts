/**
 * Eve ten-minute tick for the evening reflection: the day summed up and «what matters tomorrow».
 *
 * Export:
 * - Default schedule; the dispatcher decides whose evening it is and whether the day had anything.
 *
 * The minute is offset from the other initiative ticks so they do not read the same tables at once.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchEveningReflections } from "../lib/initiative/evening-reflection-runner.js";

export default defineSchedule({
  cron: "2-59/10 * * * *",
  run({ waitUntil }) {
    waitUntil(dispatchEveningReflections().catch((error: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_EVENING_REFLECTION_SCHEDULE_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }));
  },
});
