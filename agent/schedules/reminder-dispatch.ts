/**
 * Eve static minute dispatcher for application-managed proactive notifications.
 *
 * Export:
 * - Default minute schedule for reminders, expired-session retention, workspace cleanup,
 *   cancellation of Telegram approvals nobody confirmed in time, and physical cleanup of memory
 *   whose soft-delete recovery window has elapsed, model usage rows past their retention, and completed
 * Telegram updates past theirs, and task buttons past their seven days.
 */
import { defineSchedule } from "eve/schedules";
import { dispatchErrands } from "../lib/errands/errand-dispatcher.js";

import { dispatchDueReminders } from "../lib/reminders/reminder-dispatcher.js";
import { guestChatRepository } from "../lib/guest/guest-chat-repository.js";
import { purgeExpiredModelUsage } from "../lib/health/model-usage-repository.js";
import { purgeSoftDeletedMemory } from "../lib/memory-retention.js";
import { deleteExpiredSessions } from "../lib/sessions/session-retention.js";
import { purgeCompletedTelegramUpdates } from "../lib/telegram-ingress-retention.js";
import { taskButtonRepository } from "../lib/task-buttons/task-button-repository.js";
import { sweepTimedOutApprovals } from "../lib/telegram-hitl/approval-timeout-sweep.js";
import { deleteOrphanedWorkspaces } from "../lib/workspaces/workspace-deletion.js";

export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(Promise.all([
      dispatchDueReminders(),
      dispatchErrands(),
      deleteExpiredSessions(),
      deleteOrphanedWorkspaces(),
      sweepTimedOutApprovals(),
      purgeSoftDeletedMemory(new Date()),
      purgeExpiredModelUsage(new Date()),
      purgeCompletedTelegramUpdates(new Date()),
      guestChatRepository.purgeExpired(new Date()),
      taskButtonRepository.purgeExpired(new Date()),
    ]));
  },
});
