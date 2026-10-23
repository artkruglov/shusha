/**
 * Утренний обзор дня: единственное, что бот сегодня начинает сам.
 *
 * Экспорт:
 * - `DailyOverviewRecipient`: человек, его пояс и его правило инициативы.
 * - `createDailyOverviewDispatcher`: диспетчер с подменяемыми зависимостями.
 *
 * Порядок шагов выбран так, чтобы ни один из них нельзя было обойти: сначала утро в поясе
 * человека, потом общее правило инициативы (тихие часы, выключатель, предел суток, пауза после
 * молчания), потом содержание — и только потом заявка. Пустой обзор не занимает ни предел, ни
 * заявку: день, в котором нечего сказать, должен остаться днём без сообщения.
 *
 * Заявка пишется до отправки: два тика подряд не отправят два одинаковых обзора. Определённый
 * отказ Telegram (бот заблокирован) заявку не возвращает: повтор каждый тик только шумел бы в
 * логах. Любой другой сбой оставляет исход неизвестным — повтора тоже нет.
 * Отправленный обзор пишется в журнал доставок личного чата: иначе ответ «первое сделала» приходил
 * в ход, который обзора не видел.
 */
import { MemoryReviewOwnerAlertTransportError, type TelegramTextEntity } from "../memory-review/memory-review-owner-alert-transport.js";
import type { MorningReplyMarkup } from "../task-buttons/overview-keyboard.js";
import type { DailyOverview } from "./daily-overview.js";
import { formatShortDailyOverview, type ShortDailyOverview } from "./daily-overview-short.js";
import type { InitiativeDelivery } from "./initiative-delivery.js";
import { decideInitiative, type InitiativeSettings, type InitiativeState } from "./initiative-policy.js";

/** Раньше этого часа по местному времени утренний обзор не отправляется, если человек не выбрал свой (миграция 180). */
export const DAILY_OVERVIEW_LOCAL_HOUR = 8;

export interface DailyOverviewRecipient {
  readonly familyId: string;
  /** Обзор ещё ни разу не приходил: первое сообщение объясняет себя и называет выключатель. */
  readonly firstEver: boolean;
  /** Свой выключатель утреннего обзора: гасит только его, а не всю инициативу (миграция 180). */
  readonly overviewEnabled: boolean;
  /** Свой час обзора; `null` — `DAILY_OVERVIEW_LOCAL_HOUR`. */
  readonly overviewHour: number | null;
  readonly settings: InitiativeSettings;
  readonly state: InitiativeState;
  readonly telegramUserId: string;
  readonly userId: string;
}

export interface DailyOverviewDispatcherDependencies {
  /** Название окна личного времени, если оно идёт прямо сейчас. */
  personalTime(recipient: DailyOverviewRecipient, now: Date): Promise<string | null>;
  /** Заявка на сутки человека: ссылка доставки, `null` означает, что обзор сегодня уже отправляли. */
  claim(recipient: DailyOverviewRecipient, localDate: string): Promise<string | null>;
  /** Кнопки под обзором (миграция 179): «✓ дело» на каждое показанное дело и «Все дела». */
  keyboard(recipient: DailyOverviewRecipient, overview: ShortDailyOverview, now: Date): Promise<MorningReplyMarkup>;
  /** Отправка; возвращает подтверждённый id сообщения. */
  send(input: { chatId: string; entities?: readonly TelegramTextEntity[]; replyMarkup?: MorningReplyMarkup; text: string }): Promise<string>;
  record(delivery: InitiativeDelivery): Promise<void>;
  /** Показ дел этого утра: после трёх показов без изменений обзор их больше не повторяет (миграция 190). */
  recordShows(recipient: DailyOverviewRecipient, shown: ShortDailyOverview["shown"], localDate: string): Promise<void>;
  overview(recipient: DailyOverviewRecipient): Promise<DailyOverview>;
  recipients(): Promise<DailyOverviewRecipient[]>;
}

function localParts(timezone: string, now: Date): { date: string; hour: number } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", hour12: false, timeZone: timezone,
  }).format(now)) % 24;
  return { date, hour };
}

export function createDailyOverviewDispatcher(
  dependencies: DailyOverviewDispatcherDependencies,
) {
  return async function dispatchDailyOverviews(now = new Date()): Promise<number> {
    let sent = 0;
    for (const recipient of await dependencies.recipients()) {
      // До отправки ничего не ушло: сбой чтения или заявки у одного адресата пропускает только его.
      try {
        if (!recipient.overviewEnabled) continue;
        const local = localParts(recipient.settings.timezone, now);
        if (local.hour < (recipient.overviewHour ?? DAILY_OVERVIEW_LOCAL_HOUR)) continue;
        const decision = decideInitiative(recipient.settings, recipient.state, now);
        if (!decision.allowed) continue;
        // Личное время принадлежит человеку: обзор подождёт следующего тика, как и тихие часы.
        if (await dependencies.personalTime(recipient, now) !== null) continue;
        // Содержание раньше заявки: день без дел остаётся днём без сообщения и не тратит предел.
        const short = formatShortDailyOverview(await dependencies.overview(recipient),
          { first: recipient.firstEver });
        if (short === null) continue;
        const { entities, text } = short;
        const deliveryRef = await dependencies.claim(recipient, local.date);
        if (deliveryRef === null) continue;
        let messageId: string;
        try {
          // Кнопки создаются после заявки: обзор, который сегодня не уйдёт, не оставляет строк кнопок.
          const replyMarkup = await dependencies.keyboard(recipient, short, now);
          messageId = await dependencies.send({ chatId: recipient.telegramUserId, entities, replyMarkup, text });
        } catch (error) {
          const refused = error instanceof MemoryReviewOwnerAlertTransportError;
          console.error(JSON.stringify({
            code: refused ? "AGENT_DAILY_OVERVIEW_FAILED" : "AGENT_DAILY_OVERVIEW_AMBIGUOUS",
            error: error instanceof Error ? error.message : String(error),
            familyId: recipient.familyId,
          }));
          continue;
        }
        sent += 1;
        // Сбой учёта показов не страшен: дело просто покажется лишнее утро.
        try {
          await dependencies.recordShows(recipient, short.shownOverdue, local.date);
        } catch (error) {
          console.error(JSON.stringify({
            code: "AGENT_DAILY_OVERVIEW_SHOWS_FAILED",
            error: error instanceof Error ? error.message : String(error),
            familyId: recipient.familyId,
          }));
        }
        // Обзор уже у человека: сбой записи в журнал не делает его неотправленным.
        try {
          await dependencies.record({
            at: now, deliveryRef, familyId: recipient.familyId, messageId, sourceKind: "daily_overview",
            telegramUserId: recipient.telegramUserId, text, userId: recipient.userId,
          });
        } catch (error) {
          console.error(JSON.stringify({
            code: "AGENT_INITIATIVE_DELIVERY_RECORD_FAILED",
            error: error instanceof Error ? error.message : String(error),
            familyId: recipient.familyId,
            sourceKind: "daily_overview",
          }));
        }
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_DAILY_OVERVIEW_FAILED", error: error instanceof Error ? error.message : String(error), familyId: recipient.familyId,
        }));
      }
    }
    return sent;
  };
}
