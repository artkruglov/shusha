/**
 * Eve ten-minute tick for the message about a task that has not moved.
 *
 * Export:
 * - Default schedule; the dispatcher decides whether there is such a task and whether to write.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchStaleTasks } from "../lib/initiative/stale-task-runner.js";

export default defineSchedule({
  cron: "7-59/10 * * * *",
  run({ waitUntil }) {
    waitUntil(dispatchStaleTasks().catch((error: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_STALE_TASK_SCHEDULE_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }));
  },
});
