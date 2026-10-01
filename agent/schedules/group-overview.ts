/**
 * Eve ten-minute tick for the family group's morning overview.
 *
 * Export:
 * - Default schedule; the dispatcher decides whether it is the family's morning and whether there is
 *   anything to say.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchGroupOverviews } from "../lib/initiative/group-overview-runner.js";

export default defineSchedule({
  cron: "3-59/10 * * * *",
  run({ waitUntil }) {
    waitUntil(dispatchGroupOverviews().catch((error: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_GROUP_OVERVIEW_SCHEDULE_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }));
  },
});
