/**
 * Диспетчер сообщения о давнем деле: тот же порядок проверок, что у уведомлений.
 *
 * Экспорт:
 * - `createStaleTaskDispatcher`: диспетчер с подменяемыми зависимостями.
 *
 * Порядок: правило инициативы (выключатель, тихие часы, пауза после молчания, предел суток), личное
 * время, дело-кандидат, заявка, кнопки, отправка, запись в журнал доставок. Кандидата нет — нет и
 * сообщения. Неудачная доставка заявку не возвращает: о том же деле на той же версии не пишем дважды.
 */
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import type { OverviewReplyMarkup } from "../task-buttons/overview-keyboard.js";
import type { InitiativeDelivery } from "./initiative-delivery.js";
import { decideInitiative } from "./initiative-policy.js";
import { formatStaleTask, type StaleTask } from "./stale-task.js";
import type { StaleTaskRecipient } from "./stale-task-repository.js";

export interface StaleTaskDispatcherDependencies {
  recipients(): Promise<StaleTaskRecipient[]>;
  candidate(recipient: StaleTaskRecipient, now: Date): Promise<StaleTask | null>;
  personalTime(recipient: StaleTaskRecipient, now: Date): Promise<string | null>;
  claim(recipient: StaleTaskRecipient, localDate: string, task: StaleTask, now: Date): Promise<string | null>;
  keyboard(recipient: StaleTaskRecipient, task: StaleTask, now: Date): Promise<OverviewReplyMarkup>;
  send(input: { chatId: string; replyMarkup?: OverviewReplyMarkup; text: string }): Promise<string>;
  record(delivery: InitiativeDelivery): Promise<void>;
}

function localDate(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
}

export function createStaleTaskDispatcher(dependencies: StaleTaskDispatcherDependencies) {
  return async function dispatchStaleTasks(now = new Date()): Promise<number> {
    let sent = 0;
    for (const recipient of await dependencies.recipients()) {
      // До отправки ничего не ушло: сбой чтения или заявки у одного адресата пропускает только его.
      try {
        if (!decideInitiative(recipient.settings, recipient.state, now).allowed) continue;
        if (await dependencies.personalTime(recipient, now) !== null) continue;
        const task = await dependencies.candidate(recipient, now);
        if (task === null) continue;
        const deliveryRef = await dependencies.claim(recipient, localDate(recipient.settings.timezone, now), task, now);
        if (deliveryRef === null) continue;
        const text = formatStaleTask(task);
        let messageId: string;
        let replyMarkup: OverviewReplyMarkup;
        try {
          // Кнопки после заявки: сообщение, которое не уйдёт, не оставляет строк кнопок.
          replyMarkup = await dependencies.keyboard(recipient, task, now);
        } catch (error) {
          // До отправки: ничего не ушло, исход известен.
          console.error(JSON.stringify({
            code: "AGENT_STALE_TASK_FAILED", error: error instanceof Error ? error.message : String(error), familyId: recipient.familyId,
          }));
          continue;
        }
        try {
          messageId = await dependencies.send({ chatId: recipient.telegramUserId, replyMarkup, text });
        } catch (error) {
          console.error(JSON.stringify({
            code: error instanceof MemoryReviewOwnerAlertTransportError ? "AGENT_STALE_TASK_FAILED" : "AGENT_STALE_TASK_AMBIGUOUS",
            error: error instanceof Error ? error.message : String(error),
            familyId: recipient.familyId,
          }));
          continue;
        }
        sent += 1;
        console.info(JSON.stringify({ code: "AGENT_STALE_TASK_SENT", familyId: recipient.familyId, taskId: task.id }));
        try {
          await dependencies.record({
            at: now, deliveryRef, familyId: recipient.familyId, messageId, sourceKind: "stale_task",
            telegramUserId: recipient.telegramUserId, text, userId: recipient.userId,
          });
        } catch (error) {
          console.error(JSON.stringify({
            code: "AGENT_INITIATIVE_DELIVERY_RECORD_FAILED",
            error: error instanceof Error ? error.message : String(error),
            familyId: recipient.familyId,
            sourceKind: "stale_task",
          }));
        }
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_STALE_TASK_FAILED", error: error instanceof Error ? error.message : String(error), familyId: recipient.familyId,
        }));
      }
    }
    return sent;
  };
}
