/**
 * Разбор, отправленный в семейную группу, попадает в журнал доставок этой группы.
 *
 * Экспорт:
 * - `recordGroupOverviewDelivery`: запись отправленного утреннего разбора семейных дел.
 *
 * Без записи ответ в группе («первое беру») приходил бы в ход, который разбора не видел. Журнал
 * доставок уже показывает следующему ходу группы прежние напоминания и расписания, второго пути нет.
 */
import { proactiveDeliveryRepository } from "../proactive-deliveries/proactive-delivery-repository.js";
import type { GroupOverviewDelivery } from "./group-overview-dispatch.js";

export async function recordGroupOverviewDelivery(delivery: GroupOverviewDelivery): Promise<void> {
  await proactiveDeliveryRepository.record({
    content: delivery.text,
    deliveredAt: delivery.at,
    familyId: delivery.familyId,
    groupId: delivery.groupId,
    messageThreadId: null,
    ownerUserId: null,
    scheduledFor: delivery.at,
    scope: "family",
    sourceId: delivery.deliveryRef,
    sourceKind: "group_overview",
    telegramChatId: delivery.telegramChatId,
    telegramMessageId: delivery.messageId,
    title: "Общий обзор дел",
  });
}
