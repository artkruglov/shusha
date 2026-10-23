/**
 * Производственная сборка «фишки».
 *
 * Экспорт:
 * - `dispatchFeatureTips`: диспетчер с настоящими репозиториями, флагами сервера и транспортом.
 *
 * Флаги те же, что открывают инструменты и каталог Mini App (`webAppCapabilities`): совет о том, чего на этом
 * сервере нет, не уходит.
 */
import { selectFeatureTip } from "../coach-touches/feature-tips.js";
import { featureUseRepository } from "../feature-uses/feature-use-repository.js";
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import { personalTimeRepository } from "../personal-time/personal-time-repository.js";
import { featureTipKeyboard } from "../task-buttons/coach-touch-keyboard.js";
import { webAppCapabilities } from "../web-app/web-app-hints.js";
import { createFeatureTipDispatcher } from "./feature-tip-dispatch.js";
import { featureTipRepository } from "./feature-tip-repository.js";
import { recordInitiativeDelivery } from "./initiative-delivery.js";

export function dispatchFeatureTips(now = new Date()): Promise<number> {
  const capabilities = webAppCapabilities();
  const availability = {
    google: capabilities.google, grocery: capabilities.grocery, images: capabilities.images, video: capabilities.video,
  };
  return createFeatureTipDispatcher({
    async candidate(recipient) {
      const [shown, used] = await Promise.all([featureTipRepository.shown(recipient), featureUseRepository.used(recipient)]);
      const tip = selectFeatureTip({ availability, shown, used });
      return tip === null ? null : { first: shown.size === 0, tip };
    },
    claim: (recipient, localDate, tip, at) => featureTipRepository.claim(recipient, localDate, tip.id, at),
    keyboard: (recipient, tip, at) => featureTipKeyboard({
      familyId: recipient.familyId, now: at, telegramUserId: recipient.telegramUserId, tip,
    }),
    personalTime: (recipient, at) => personalTimeRepository.conflictFor(recipient.telegramUserId, recipient.familyId, at),
    recipients: () => featureTipRepository.recipients(now),
    record: recordInitiativeDelivery,
    send: (input) => memoryReviewOwnerAlertTransport.send(input),
  })(now);
}
