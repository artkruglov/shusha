/**
 * Производственная сборка утреннего обзора.
 *
 * Экспорт:
 * - `dispatchDailyOverviews`: диспетчер с настоящими репозиторием и транспортом.
 *
 * Отдельный файл, потому что расписание Eve грузится при старте, а диспетчер и его зависимости
 * должны оставаться подменяемыми в тестах.
 */
import { createDailyOverviewDispatcher } from "./daily-overview-dispatch.js";
import { dailyOverviewRepository } from "./daily-overview-repository.js";
import type { OverviewTask } from "./daily-overview.js";
import { recordInitiativeDelivery } from "./initiative-delivery.js";
import { overviewRestRepository } from "./overview-rest-repository.js";
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import { personalTimeRepository } from "../personal-time/personal-time-repository.js";
import { overviewKeyboard } from "../task-buttons/overview-keyboard.js";
import { webAppUrl } from "../web-app/web-app-menu.js";
import { claimIfReachable } from "../telegram-reachability/reachability-guard.js";

export function dispatchDailyOverviews(now = new Date()): Promise<number> {
  return createDailyOverviewDispatcher({
    claim: (recipient, localDate) => claimIfReachable(recipient.telegramUserId, "initiative",
      () => dailyOverviewRepository.claim(recipient, localDate)),
    keyboard: (recipient, overview, at) => overviewKeyboard({
      familyId: recipient.familyId, now: at, openCount: overview.openCount,
      shown: overview.shown, telegramUserId: recipient.telegramUserId, webAppUrl: webAppUrl(),
    }),
    record: recordInitiativeDelivery,
    send: (input) => memoryReviewOwnerAlertTransport.send(input),
    overview: async (recipient) => {
      const overview = await dailyOverviewRepository.overview(recipient);
      return { ...overview, rest: await overviewRestRepository.read(recipient.userId, versioned(overview.tasks)) };
    },
    recordShows: (recipient, shown, localDate) => overviewRestRepository.recordShows({
      familyId: recipient.familyId, shownOn: localDate, tasks: versioned(shown), userId: recipient.userId,
    }),
    personalTime: (recipient, at) =>
      personalTimeRepository.conflictFor(recipient.telegramUserId, recipient.familyId, at),
    recipients: () => dailyOverviewRepository.recipients(now),
  })(now);
}

/** Дела с id и версией: только по ним считаются показы. */
function versioned(tasks: readonly OverviewTask[]): { id: string; version: number }[] {
  return tasks.flatMap((task) => typeof task.id === "string" && typeof task.version === "number"
    ? [{ id: task.id, version: task.version }] : []);
}
