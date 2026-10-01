/**
 * Диспетчер коуча: тот же порядок проверок, что у утреннего обзора, другой источник текста.
 *
 * Экспорт:
 * - `createCoachDispatcher`: диспетчер с подменяемыми зависимостями.
 *
 * Порядок: общее правило инициативы (выключатель, тихие часы, пауза после молчания, предел
 * суток), личное время, повод, заявка, отправка, запись в журнал доставок. Повода нет — нет и
 * сообщения: потолок касаний не расписание. Определённый отказ Telegram (бот заблокирован)
 * заявку не возвращает: иначе каждый десятиминутный тик пробовал бы снова, шестьдесят раз в
 * сутки. Неизвестный исход повтора тоже не получает. Сообщение, ушедшее без записи в журнал,
 * остаётся отправленным: сбой записи только логируется.
 */
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import { chooseCoachTouch, type CoachTouch } from "./coach.js";
import type { CoachRecipient } from "./coach-repository.js";
import type { InitiativeDelivery } from "./initiative-delivery.js";
import { decideInitiative } from "./initiative-policy.js";

export interface CoachDispatcherDependencies {
  recipients(): Promise<CoachRecipient[]>;
  personalTime(recipient: CoachRecipient, now: Date): Promise<string | null>;
  claim(recipient: CoachRecipient, localDate: string, touch: CoachTouch, now: Date): Promise<string | null>;
  send(input: { chatId: string; text: string }): Promise<string>;
  record(delivery: InitiativeDelivery): Promise<void>;
}

/** Диспетчер создаётся на каждый тик, поэтому память о записанных причинах живёт в модуле. */
const reportedSkips = new Set<string>();
const REPORTED_SKIPS_LIMIT = 2000;

export function resetCoachSkipLog(): void {
  reportedSkips.clear();
}

function reportSkip(recipient: CoachRecipient, date: string, reason: string): void {
  const key = `${recipient.userId}:${date}:${reason}`;
  if (reportedSkips.has(key)) return;
  if (reportedSkips.size >= REPORTED_SKIPS_LIMIT) reportedSkips.clear();
  reportedSkips.add(key);
  console.info(JSON.stringify({
    code: "AGENT_COACH_SKIPPED",
    enabled: recipient.facts.enabled,
    familyId: recipient.familyId,
    invitesSent: recipient.facts.invitesSent,
    reason,
    relation: recipient.facts.relation,
    unanswered: recipient.state.unanswered,
    userId: recipient.userId,
  }));
}

function localClock(timezone: string, now: Date): { date: string; hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit", hour: "2-digit", hour12: false, month: "2-digit",
    timeZone: timezone, weekday: "short", year: "numeric",
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")) % 24,
    weekday: weekdays.indexOf(part("weekday")),
  };
}

export function createCoachDispatcher(dependencies: CoachDispatcherDependencies) {
  return async function dispatchCoach(now = new Date()): Promise<number> {
    let sent = 0;
    for (const recipient of await dependencies.recipients()) {
      const clock = localClock(recipient.settings.timezone, now);
      const decision = decideInitiative(recipient.settings, recipient.state, now);
      if (!decision.allowed) {
        if (decision.reason !== "quiet_hours") reportSkip(recipient, clock.date, decision.reason);
        continue;
      }
      const touch = chooseCoachTouch(recipient.facts, clock, now);
      if (touch === null) {
        reportSkip(recipient, clock.date, "no_reason");
        continue;
      }
      if (await dependencies.personalTime(recipient, now) !== null) {
        reportSkip(recipient, clock.date, "personal_time");
        continue;
      }
      const deliveryRef = await dependencies.claim(recipient, clock.date, touch, now);
      if (deliveryRef === null) continue;
      let messageId: string;
      try {
        messageId = await dependencies.send({ chatId: recipient.telegramUserId, text: touch.text });
      } catch (error) {
        const refused = error instanceof MemoryReviewOwnerAlertTransportError;
        console.error(JSON.stringify({
          code: refused ? "AGENT_COACH_TOUCH_FAILED" : "AGENT_COACH_TOUCH_AMBIGUOUS",
          error: error instanceof Error ? error.message : String(error),
          familyId: recipient.familyId,
          reason: touch.reason,
        }));
        continue;
      }
      sent += 1;
      console.info(JSON.stringify({ code: "AGENT_COACH_TOUCH_SENT", familyId: recipient.familyId, reason: touch.reason }));
      try {
        await dependencies.record({
          at: now, deliveryRef, familyId: recipient.familyId, messageId, sourceKind: "coach",
          telegramUserId: recipient.telegramUserId, text: touch.text, userId: recipient.userId,
        });
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_INITIATIVE_DELIVERY_RECORD_FAILED",
          error: error instanceof Error ? error.message : String(error),
          familyId: recipient.familyId,
          sourceKind: "coach",
        }));
      }
    }
    return sent;
  };
}
