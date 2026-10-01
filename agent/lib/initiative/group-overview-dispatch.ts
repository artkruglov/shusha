/**
 * Диспетчер утреннего разбора семейных дел в группе.
 *
 * Экспорт:
 * - `GROUP_OVERVIEW_LOCAL_HOUR`: час по поясу семьи, раньше которого разбор не уходит.
 * - `createGroupOverviewDispatcher`: диспетчер с подменяемыми зависимостями.
 *
 * Порядок тот же, что у личного обзора: утро в поясе семьи, содержание, заявка, отправка, запись.
 * Пустой разбор не занимает заявку: день без дел остаётся днём без сообщения. Заявка пишется до
 * отправки, определённый отказ Telegram её не возвращает (заблокированная группа не должна
 * пробоваться каждый тик), неизвестный исход тоже. Ответ в группе на разбор приходит в ход, который
 * его не видел, поэтому отправленное пишется в журнал доставок группы.
 */
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import { formatGroupOverview, type GroupOverview } from "./group-overview.js";
import type { OverviewGroup } from "./group-overview-repository.js";

/** Час на час позже личного обзора: утро группы не должно совпадать с утром каждого из двоих. */
export const GROUP_OVERVIEW_LOCAL_HOUR = 9;

export interface GroupOverviewDelivery {
  readonly at: Date;
  readonly deliveryRef: string;
  readonly familyId: string;
  readonly groupId: string;
  readonly messageId: string;
  readonly telegramChatId: string;
  readonly text: string;
}

export interface GroupOverviewDispatcherDependencies {
  claim(group: OverviewGroup, localDate: string): Promise<string | null>;
  groups(): Promise<OverviewGroup[]>;
  overview(group: OverviewGroup, now: Date): Promise<GroupOverview>;
  record(delivery: GroupOverviewDelivery): Promise<void>;
  send(input: { chatId: string; text: string }): Promise<string>;
}

function localParts(timezone: string, now: Date): { date: string; hour: number } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", hour12: false, timeZone: timezone,
  }).format(now)) % 24;
  return { date, hour };
}

export function createGroupOverviewDispatcher(dependencies: GroupOverviewDispatcherDependencies) {
  return async function dispatchGroupOverviews(now = new Date()): Promise<number> {
    let sent = 0;
    for (const group of await dependencies.groups()) {
      const local = localParts(group.timezone, now);
      if (local.hour < GROUP_OVERVIEW_LOCAL_HOUR) continue;
      const text = formatGroupOverview(await dependencies.overview(group, now), { first: group.firstEver });
      if (text === null) continue;
      const deliveryRef = await dependencies.claim(group, local.date);
      if (deliveryRef === null) continue;
      let messageId: string;
      try {
        messageId = await dependencies.send({ chatId: group.telegramChatId, text });
      } catch (error) {
        const refused = error instanceof MemoryReviewOwnerAlertTransportError;
        console.error(JSON.stringify({
          code: refused ? "AGENT_GROUP_OVERVIEW_FAILED" : "AGENT_GROUP_OVERVIEW_AMBIGUOUS",
          error: error instanceof Error ? error.message : String(error),
          familyId: group.familyId,
          groupId: group.groupId,
        }));
        continue;
      }
      sent += 1;
      console.info(JSON.stringify({ code: "AGENT_GROUP_OVERVIEW_SENT", familyId: group.familyId, groupId: group.groupId }));
      // Разбор уже в группе: сбой записи в журнал не делает его неотправленным.
      try {
        await dependencies.record({
          at: now, deliveryRef, familyId: group.familyId, groupId: group.groupId, messageId,
          telegramChatId: group.telegramChatId, text,
        });
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_INITIATIVE_DELIVERY_RECORD_FAILED",
          error: error instanceof Error ? error.message : String(error),
          familyId: group.familyId,
          sourceKind: "group_overview",
        }));
      }
    }
    return sent;
  };
}
