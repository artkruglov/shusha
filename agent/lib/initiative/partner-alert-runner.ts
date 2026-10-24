/**
 * Производственная сборка уведомлений о том, что ждёт ответа.
 *
 * Экспорт:
 * - `dispatchPartnerAlerts`: диспетчер с настоящими репозиторием и транспортом.
 */
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import { personalTimeRepository } from "../personal-time/personal-time-repository.js";
import { recordInitiativeDelivery } from "./initiative-delivery.js";
import { createPartnerAlertDispatcher } from "./partner-alert-dispatch.js";
import { partnerAlertRepository } from "./partner-alert-repository.js";
import { requestKeyboard } from "../task-buttons/request-keyboards.js";
import { claimIfReachable } from "../telegram-reachability/reachability-guard.js";

export function dispatchPartnerAlerts(now = new Date()): Promise<number> {
  return createPartnerAlertDispatcher({
    claim: (recipient, localDate, items, at) => claimIfReachable(recipient.telegramUserId, "initiative",
      () => partnerAlertRepository.claim(recipient, localDate, items, at)),
    keyboard: (recipient, items, at) => requestKeyboard({
      familyId: recipient.familyId,
      now: at,
      tasks: items.flatMap((item) => item.kind === "task_proposed" && item.version !== undefined
        ? [{ id: item.subjectId, title: item.title, version: item.version }] : []),
      telegramUserId: recipient.telegramUserId,
    }),
    pending: (recipient, at) => partnerAlertRepository.pending(recipient, at),
    personalTime: (recipient, at) =>
      personalTimeRepository.conflictFor(recipient.telegramUserId, recipient.familyId, at),
    recipients: () => partnerAlertRepository.recipients(now),
    record: recordInitiativeDelivery,
    send: (input) => memoryReviewOwnerAlertTransport.send(input),
  })(now);
}
