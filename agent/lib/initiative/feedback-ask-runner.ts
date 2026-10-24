/**
 * Производственная сборка вопроса «что мешает».
 *
 * Экспорт:
 * - `dispatchFeedbackAsks`: диспетчер с настоящими репозиторием и транспортом.
 */
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import { personalTimeRepository } from "../personal-time/personal-time-repository.js";
import { createFeedbackAskDispatcher } from "./feedback-ask-dispatch.js";
import { feedbackAskRepository } from "./feedback-ask-repository.js";
import { recordInitiativeDelivery } from "./initiative-delivery.js";
import { claimIfReachable } from "../telegram-reachability/reachability-guard.js";

export function dispatchFeedbackAsks(now = new Date()): Promise<number> {
  return createFeedbackAskDispatcher({
    claim: (recipient, localDate, at) => claimIfReachable(recipient.telegramUserId, "initiative",
      () => feedbackAskRepository.claim(recipient, localDate, at)),
    personalTime: (recipient, at) => personalTimeRepository.conflictFor(recipient.telegramUserId, recipient.familyId, at),
    recipients: () => feedbackAskRepository.recipients(now),
    record: recordInitiativeDelivery,
    send: (input) => memoryReviewOwnerAlertTransport.send(input),
  })(now);
}
