/**
 * Производственная сборка утреннего разбора семейных дел в группе.
 *
 * Экспорт:
 * - `dispatchGroupOverviews`: диспетчер с настоящими репозиторием и транспортом.
 *
 * Отдельный файл, потому что расписание Eve грузится при старте, а диспетчер и его зависимости
 * должны оставаться подменяемыми в тестах.
 */
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import { recordGroupOverviewDelivery } from "./group-overview-delivery.js";
import { createGroupOverviewDispatcher } from "./group-overview-dispatch.js";
import { groupOverviewRepository } from "./group-overview-repository.js";

export function dispatchGroupOverviews(now = new Date()): Promise<number> {
  return createGroupOverviewDispatcher({
    claim: (group, localDate) => groupOverviewRepository.claim(group, localDate),
    groups: () => groupOverviewRepository.groups(now),
    overview: async (group, at) => ({
      now: at, tasks: await groupOverviewRepository.tasks(group), timezone: group.timezone,
    }),
    record: recordGroupOverviewDelivery,
    send: (input) => memoryReviewOwnerAlertTransport.send(input),
  })(now);
}
