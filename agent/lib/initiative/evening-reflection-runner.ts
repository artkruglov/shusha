/**
 * Производственная сборка итога дня.
 *
 * Экспорт:
 * - `dispatchEveningReflections`: диспетчер с настоящими репозиторием и транспортом.
 */
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import { personalTimeRepository } from "../personal-time/personal-time-repository.js";
import { eveningReflectionKeyboard } from "../task-buttons/coach-touch-keyboard.js";
import { createEveningReflectionDispatcher } from "./evening-reflection-dispatch.js";
import { eveningReflectionRepository } from "./evening-reflection-repository.js";
import { recordInitiativeDelivery } from "./initiative-delivery.js";
import { claimIfReachable } from "../telegram-reachability/reachability-guard.js";

export function dispatchEveningReflections(now = new Date()): Promise<number> {
  return createEveningReflectionDispatcher({
    claim: (recipient, localDate, at) => claimIfReachable(recipient.telegramUserId, "initiative",
      () => eveningReflectionRepository.claim(recipient, localDate, at)),
    content: (recipient, localDate, at) => eveningReflectionRepository.content(recipient, localDate, at),
    keyboard: (recipient, at) => eveningReflectionKeyboard({
      familyId: recipient.familyId, now: at, telegramUserId: recipient.telegramUserId,
    }),
    personalTime: (recipient, at) => personalTimeRepository.conflictFor(recipient.telegramUserId, recipient.familyId, at),
    recipients: () => eveningReflectionRepository.recipients(now),
    record: recordInitiativeDelivery,
    send: (input) => memoryReviewOwnerAlertTransport.send(input),
  })(now);
}
