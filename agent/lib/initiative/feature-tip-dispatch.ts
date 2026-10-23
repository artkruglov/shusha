/**
 * Диспетчер «фишки»: тот же порядок проверок, что у вопроса «что мешает», и кнопки, как у давнего дела.
 *
 * Экспорт:
 * - `FEATURE_TIP_WEEKDAYS`, `FEATURE_TIP_FIRST_HOUR`, `FEATURE_TIP_LAST_HOUR`: когда совет может прийти.
 * - `createFeatureTipDispatcher`: диспетчер с подменяемыми зависимостями.
 *
 * Не чаще двух раз в неделю: вторник и пятница днём по времени человека, по заявке на день (миграция 196). Дальше
 * общее правило инициативы (выключатель, тихие часы, пауза после молчания, предел суток), личное время, совет-кандидат,
 * заявка вместе с отметкой показа, кнопки, отправка, запись в журнал доставок. Нет непробованного — нет и сообщения.
 * Определённый отказ Telegram заявку не возвращает: этот совет больше не придёт, следующий придёт в свой день.
 */
import type { FeatureTip } from "../coach-touches/feature-tips.js";
import { formatFeatureTip } from "../coach-touches/feature-tips.js";
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import type { OverviewReplyMarkup } from "../task-buttons/overview-keyboard.js";
import type { FeatureTipRecipient } from "./feature-tip-repository.js";
import type { InitiativeDelivery } from "./initiative-delivery.js";
import { decideInitiative } from "./initiative-policy.js";
import { localClock } from "./weekly-review-dispatch.js";

/** Вторник и пятница: середина недели и её конец, не подряд и не в выходные с обзором недели. */
export const FEATURE_TIP_WEEKDAYS: ReadonlySet<number> = new Set([2, 5]);
export const FEATURE_TIP_FIRST_HOUR = 12;
export const FEATURE_TIP_LAST_HOUR = 19;

export interface FeatureTipCandidate {
  readonly tip: FeatureTip;
  /** Человеку ещё не показывали ни одного совета: сообщение объясняет себя. */
  readonly first: boolean;
}

export interface FeatureTipDispatcherDependencies {
  recipients(): Promise<FeatureTipRecipient[]>;
  personalTime(recipient: FeatureTipRecipient, now: Date): Promise<string | null>;
  candidate(recipient: FeatureTipRecipient): Promise<FeatureTipCandidate | null>;
  claim(recipient: FeatureTipRecipient, localDate: string, tip: FeatureTip, now: Date): Promise<string | null>;
  keyboard(recipient: FeatureTipRecipient, tip: FeatureTip, now: Date): Promise<OverviewReplyMarkup>;
  send(input: { chatId: string; replyMarkup?: OverviewReplyMarkup; text: string }): Promise<string>;
  record(delivery: InitiativeDelivery): Promise<void>;
}

function log(code: string, recipient: FeatureTipRecipient, error: unknown): void {
  console.error(JSON.stringify({ code, error: error instanceof Error ? error.message : String(error), familyId: recipient.familyId }));
}

export function createFeatureTipDispatcher(dependencies: FeatureTipDispatcherDependencies) {
  return async function dispatchFeatureTips(now = new Date()): Promise<number> {
    let sent = 0;
    for (const recipient of await dependencies.recipients()) {
      // До отправки ничего не ушло: сбой чтения или заявки у одного адресата пропускает только его.
      try {
        const clock = localClock(recipient.settings.timezone, now);
        if (!FEATURE_TIP_WEEKDAYS.has(clock.weekday)) continue;
        if (clock.hour < FEATURE_TIP_FIRST_HOUR || clock.hour >= FEATURE_TIP_LAST_HOUR) continue;
        if (!decideInitiative(recipient.settings, recipient.state, now).allowed) continue;
        if (await dependencies.personalTime(recipient, now) !== null) continue;
        const candidate = await dependencies.candidate(recipient);
        if (candidate === null) continue;
        const deliveryRef = await dependencies.claim(recipient, clock.date, candidate.tip, now);
        if (deliveryRef === null) continue;
        const text = formatFeatureTip(candidate.tip, candidate.first);
        let replyMarkup: OverviewReplyMarkup;
        try {
          // Кнопки после заявки: совет, который не уйдёт, не оставляет строк кнопок.
          replyMarkup = await dependencies.keyboard(recipient, candidate.tip, now);
        } catch (error) {
          log("AGENT_FEATURE_TIP_FAILED", recipient, error);
          continue;
        }
        let messageId: string;
        try {
          messageId = await dependencies.send({ chatId: recipient.telegramUserId, replyMarkup, text });
        } catch (error) {
          log(error instanceof MemoryReviewOwnerAlertTransportError ? "AGENT_FEATURE_TIP_FAILED" : "AGENT_FEATURE_TIP_AMBIGUOUS",
            recipient, error);
          continue;
        }
        sent += 1;
        console.info(JSON.stringify({ code: "AGENT_FEATURE_TIP_SENT", familyId: recipient.familyId, tip: candidate.tip.id }));
        try {
          await dependencies.record({
            at: now, deliveryRef, familyId: recipient.familyId, messageId, sourceKind: "feature_tip",
            telegramUserId: recipient.telegramUserId, text, userId: recipient.userId,
          });
        } catch (error) {
          console.error(JSON.stringify({
            code: "AGENT_INITIATIVE_DELIVERY_RECORD_FAILED",
            error: error instanceof Error ? error.message : String(error),
            familyId: recipient.familyId,
            sourceKind: "feature_tip",
          }));
        }
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_FEATURE_TIP_FAILED", error: error instanceof Error ? error.message : String(error), familyId: recipient.familyId,
        }));
      }
    }
    return sent;
  };
}
