/**
 * Диспетчер итога дня: тот же порядок проверок, что у недельного обзора, раз в сутки вечером.
 *
 * Экспорт:
 * - `EVENING_REFLECTION_FIRST_HOUR`, `EVENING_REFLECTION_LAST_HOUR`: окно по местному времени человека.
 * - `createEveningReflectionDispatcher`: диспетчер с подменяемыми зависимостями.
 *
 * Порядок: вечер его дня, общее правило инициативы (выключатель, тихие часы, пауза после молчания, предел суток),
 * личное время, содержание дня, заявка, кнопка, отправка, запись в журнал доставок. Пустой день заявку не тратит:
 * вечер без дел проходит молча, и следующий тик того же вечера может найти закрытое только что. Определённый отказ
 * Telegram заявку не возвращает: иначе каждый тик вечера пробовал бы снова.
 */
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import type { OverviewReplyMarkup } from "../task-buttons/overview-keyboard.js";
import { formatEveningReflection, type EveningReflectionInput } from "./evening-reflection.js";
import type { EveningReflectionRecipient } from "./evening-reflection-repository.js";
import type { InitiativeDelivery } from "./initiative-delivery.js";
import { decideInitiative } from "./initiative-policy.js";
import { localClock } from "./weekly-review-dispatch.js";

export const EVENING_REFLECTION_FIRST_HOUR = 20;
export const EVENING_REFLECTION_LAST_HOUR = 22;

export interface EveningReflectionDispatcherDependencies {
  recipients(): Promise<EveningReflectionRecipient[]>;
  personalTime(recipient: EveningReflectionRecipient, now: Date): Promise<string | null>;
  content(recipient: EveningReflectionRecipient, localDate: string, now: Date): Promise<EveningReflectionInput>;
  claim(recipient: EveningReflectionRecipient, localDate: string, now: Date): Promise<string | null>;
  keyboard(recipient: EveningReflectionRecipient, now: Date): Promise<OverviewReplyMarkup>;
  send(input: { chatId: string; replyMarkup?: OverviewReplyMarkup; text: string }): Promise<string>;
  record(delivery: InitiativeDelivery): Promise<void>;
}

function log(code: string, recipient: EveningReflectionRecipient, error: unknown): void {
  console.error(JSON.stringify({ code, error: error instanceof Error ? error.message : String(error), familyId: recipient.familyId }));
}

export function createEveningReflectionDispatcher(dependencies: EveningReflectionDispatcherDependencies) {
  return async function dispatchEveningReflections(now = new Date()): Promise<number> {
    let sent = 0;
    for (const recipient of await dependencies.recipients()) {
      // До отправки ничего не ушло: сбой чтения или заявки у одного адресата пропускает только его.
      try {
        const clock = localClock(recipient.settings.timezone, now);
        if (clock.hour < EVENING_REFLECTION_FIRST_HOUR || clock.hour >= EVENING_REFLECTION_LAST_HOUR) continue;
        if (!decideInitiative(recipient.settings, recipient.state, now).allowed) continue;
        if (await dependencies.personalTime(recipient, now) !== null) continue;
        const text = formatEveningReflection(await dependencies.content(recipient, clock.date, now));
        if (text === null) continue;
        const deliveryRef = await dependencies.claim(recipient, clock.date, now);
        if (deliveryRef === null) continue;
        let replyMarkup: OverviewReplyMarkup;
        try {
          replyMarkup = await dependencies.keyboard(recipient, now);
        } catch (error) {
          log("AGENT_EVENING_REFLECTION_FAILED", recipient, error);
          continue;
        }
        let messageId: string;
        try {
          messageId = await dependencies.send({ chatId: recipient.telegramUserId, replyMarkup, text });
        } catch (error) {
          log(error instanceof MemoryReviewOwnerAlertTransportError ? "AGENT_EVENING_REFLECTION_FAILED" : "AGENT_EVENING_REFLECTION_AMBIGUOUS",
            recipient, error);
          continue;
        }
        sent += 1;
        console.info(JSON.stringify({ code: "AGENT_EVENING_REFLECTION_SENT", familyId: recipient.familyId }));
        try {
          await dependencies.record({
            at: now, deliveryRef, familyId: recipient.familyId, messageId, sourceKind: "evening_reflection",
            telegramUserId: recipient.telegramUserId, text, userId: recipient.userId,
          });
        } catch (error) {
          console.error(JSON.stringify({
            code: "AGENT_INITIATIVE_DELIVERY_RECORD_FAILED",
            error: error instanceof Error ? error.message : String(error),
            familyId: recipient.familyId,
            sourceKind: "evening_reflection",
          }));
        }
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_EVENING_REFLECTION_FAILED", error: error instanceof Error ? error.message : String(error), familyId: recipient.familyId,
        }));
      }
    }
    return sent;
  };
}
