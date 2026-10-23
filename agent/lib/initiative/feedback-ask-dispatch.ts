/**
 * Вопрос «что мешает» семьям друзей на бете: раз в неделю, тот же порядок проверок, что у обзора.
 *
 * Экспорт:
 * - `FEEDBACK_ASK_TEXT`, `FEEDBACK_ASK_LIMIT`: текст, собранный кодом, и сколько раз всего спросить.
 * - `createFeedbackAskDispatcher`: диспетчер с подменяемыми зависимостями.
 *
 * `/feedback` есть, но команду без повода никто не набирает, а оператор чужих чатов не читает. Поэтому
 * бот сам спрашивает раз в неделю, в субботу днём по времени человека, и не больше четырёх раз: это
 * вопрос беты, а не вечная рассылка. Выборка уже отсекает семью оператора, новичков первой недели,
 * исчерпавших счёт и тех, кто сам писал `/feedback` на этой неделе. Дальше общее правило инициативы,
 * личное время, заявка на неделю, отправка и запись в журнал доставок. Определённый отказ Telegram
 * заявку не возвращает, как у обзора: иначе каждый тик дня пробовал бы снова.
 */
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import type { InitiativeDelivery } from "./initiative-delivery.js";
import { decideInitiative } from "./initiative-policy.js";
import type { FeedbackAskRecipient } from "./feedback-ask-repository.js";
import { localClock } from "./weekly-review-dispatch.js";

/** Суббота: неделя прожита, а на воскресный вечер уже стоит недельный обзор. */
const FEEDBACK_ASK_WEEKDAY = 6;
export const FEEDBACK_ASK_FIRST_HOUR = 12;
export const FEEDBACK_ASK_LAST_HOUR = 19;
export const FEEDBACK_ASK_LIMIT = 4;

export const FEEDBACK_ASK_TEXT = [
  "Короткий вопрос от разработчика: что за эту неделю мешало, раздражало или не получилось?",
  "Ответьте одной фразой командой /feedback и текстом — я перешлю ему как есть.",
  `Больше ${FEEDBACK_ASK_LIMIT} раз так спрашивать не буду.`,
].join("\n");

export interface FeedbackAskDispatcherDependencies {
  recipients(): Promise<FeedbackAskRecipient[]>;
  personalTime(recipient: FeedbackAskRecipient, now: Date): Promise<string | null>;
  claim(recipient: FeedbackAskRecipient, localDate: string, now: Date): Promise<string | null>;
  send(input: { chatId: string; text: string }): Promise<string>;
  record(delivery: InitiativeDelivery): Promise<void>;
}

export function createFeedbackAskDispatcher(dependencies: FeedbackAskDispatcherDependencies) {
  return async function dispatchFeedbackAsk(now = new Date()): Promise<number> {
    let sent = 0;
    for (const recipient of await dependencies.recipients()) {
      // До отправки ничего не ушло: сбой чтения или заявки у одного адресата пропускает только его.
      try {
        const clock = localClock(recipient.settings.timezone, now);
        if (clock.weekday !== FEEDBACK_ASK_WEEKDAY) continue;
        if (clock.hour < FEEDBACK_ASK_FIRST_HOUR || clock.hour >= FEEDBACK_ASK_LAST_HOUR) continue;
        // Выборка считает то же; проверка здесь держит предел, даже если запрос ошибся.
        if (recipient.asked >= FEEDBACK_ASK_LIMIT) continue;
        if (!decideInitiative(recipient.settings, recipient.state, now).allowed) continue;
        if (await dependencies.personalTime(recipient, now) !== null) continue;
        const deliveryRef = await dependencies.claim(recipient, clock.date, now);
        if (deliveryRef === null) continue;
        let messageId: string;
        try {
          messageId = await dependencies.send({ chatId: recipient.telegramUserId, text: FEEDBACK_ASK_TEXT });
        } catch (error) {
          const refused = error instanceof MemoryReviewOwnerAlertTransportError;
          console.error(JSON.stringify({
            code: refused ? "AGENT_FEEDBACK_ASK_FAILED" : "AGENT_FEEDBACK_ASK_AMBIGUOUS",
            error: error instanceof Error ? error.message : String(error),
            familyId: recipient.familyId,
          }));
          continue;
        }
        sent += 1;
        console.info(JSON.stringify({ code: "AGENT_FEEDBACK_ASK_SENT", familyId: recipient.familyId }));
        try {
          await dependencies.record({
            at: now, deliveryRef, familyId: recipient.familyId, messageId, sourceKind: "feedback_ask",
            telegramUserId: recipient.telegramUserId, text: FEEDBACK_ASK_TEXT, userId: recipient.userId,
          });
        } catch (error) {
          console.error(JSON.stringify({
            code: "AGENT_INITIATIVE_DELIVERY_RECORD_FAILED",
            error: error instanceof Error ? error.message : String(error),
            familyId: recipient.familyId,
            sourceKind: "feedback_ask",
          }));
        }
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_FEEDBACK_ASK_FAILED", error: error instanceof Error ? error.message : String(error), familyId: recipient.familyId,
        }));
      }
    }
    return sent;
  };
}
