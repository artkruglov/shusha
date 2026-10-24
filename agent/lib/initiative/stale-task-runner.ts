/**
 * Производственная сборка сообщения о давнем деле.
 *
 * Экспорт:
 * - `dispatchStaleTasks`: диспетчер с настоящими репозиторием и транспортом.
 */
import { familyBudgetRepository } from "../family-budget-repository.js";
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import { personalTimeRepository } from "../personal-time/personal-time-repository.js";
import { staleTaskKeyboard } from "../task-buttons/stale-task-keyboard.js";
import { recordInitiativeDelivery } from "./initiative-delivery.js";
import { createStaleTaskDispatcher } from "./stale-task-dispatch.js";
import { staleTaskRepository } from "./stale-task-repository.js";
import { claimIfReachable } from "../telegram-reachability/reachability-guard.js";

export function dispatchStaleTasks(now = new Date()): Promise<number> {
  return createStaleTaskDispatcher({
    candidate: (recipient, at) => staleTaskRepository.candidate(recipient, at),
    claim: (recipient, localDate, task, at) => claimIfReachable(recipient.telegramUserId, "initiative",
      () => staleTaskRepository.claim(recipient, localDate, task, at)),
    keyboard: async (recipient, task, at) => staleTaskKeyboard({
      familyId: recipient.familyId,
      modelAvailable: await familyBudgetRepository.modelAvailable({ familyId: recipient.familyId, now: at }),
      now: at, task, telegramUserId: recipient.telegramUserId,
    }),
    personalTime: (recipient, at) =>
      personalTimeRepository.conflictFor(recipient.telegramUserId, recipient.familyId, at),
    recipients: () => staleTaskRepository.recipients(now),
    record: recordInitiativeDelivery,
    send: (input) => memoryReviewOwnerAlertTransport.send(input),
  })(now);
}
