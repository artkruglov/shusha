/**
 * Коуч: один короткий вопрос не про дела, когда для него есть проверяемый повод.
 *
 * Экспорт:
 * - `CoachReason`: повод касания; журнал инициативы хранит его в `coach_reason`.
 * - `CoachFacts`: что известно о человеке из базы, без текста его переписки.
 * - `CoachTouch`: выбранное касание: повод, предмет и текст.
 * - `chooseCoachTouch`: правило выбора, без базы и без часов сервера.
 *
 * Документ о балансе семьи (`docs/family-balance-and-growth.ru.md`) описывает традиции, личное
 * время и тёплый недельный вопрос, но задуман пассивным: первый разговор оставлен людям, и за
 * месяц он не состоялся ни разу. Коуч это его проактивная половина с теми же запретами.
 * Расписания нет, есть потолок: касание только по поводу, не чаще раза в двое суток и трёх раз в
 * неделю. Коуч не говорит о делах и сроках, это работа утреннего обзора, иначе он стал бы вторым
 * напоминателем. Нагрузку не считает: число дел не мера вклада. Пропущенную традицию не ставит в
 * вину: вопрос предлагает отметить, пропустить или снять её.
 *
 * Включён по умолчанию (29 сентября 2026, решение владельца): пока приглашение требовало явного
 * «да», коуч молчал у всех, потому что «да» никто не сказал, а жалоба была именно в том, что бот
 * ничего не спрашивает. Теперь человек один раз получает объявление, что вопросы будут, и как их
 * выключить («без коуча», «не пиши мне первым»); после него молчание значит «можно». Выключенное
 * не включается само: `coach_enabled = false` никогда не пересматривается.
 *
 * Поводы делятся по отношениям (22 сентября 2026): традиции вдвоём и первая совместная практика
 * обращены к партнёру, а время для себя, тёплый вопрос недели и адресованное решение годятся
 * любому взрослому. Отношения с родителем это другие отношения, и смешивать их нельзя.
 *
 * У включённого недельного обзора тёплый вопрос недели отбирается: обзор спрашивает про ту же
 * неделю в тот же воскресный вечер, и два вопроса подряд человек читает как рассылку.
 */

export type CoachReason =
  | "invite"
  | "decision_open"
  | "ritual_checkin"
  | "week_warm"
  | "rest_window_missing"
  | "ritual_none"
  | "care_area_offer"
  | "situation_followup";

export interface CoachFacts {
  /** `null`: приглашения ещё не было или на него не ответили; `false`: «без коуча». */
  readonly enabled: boolean | null;
  /** Кто человек владельцу семьи. Пока не сказано — только нейтральные вопросы. */
  readonly relation: "child" | "other" | "parent" | "partner" | null;
  readonly invited: boolean;
  /** Сколько объявлений уже отправлено; только для лога, повторов у объявления нет. */
  readonly invitesSent: number;
  readonly lastTouchAt: Date | null;
  readonly touchesLastWeek: number;
  readonly lastByReason: Partial<Record<CoachReason, Date>>;
  /** Предложение партнёра, на которое человек ещё не ответил и о котором коуч не спрашивал. */
  readonly openDecision: { readonly id: string; readonly title: string; readonly proposer: string } | null;
  /**
   * Личное событие человека (приём, экзамен, трудный разговор) с датой в последние дни, о котором
   * коуч ещё не спрашивал. Текст записи выходит только к самому человеку в его личный чат.
   */
  readonly openSituation: { readonly id: string; readonly text: string } | null;
  /** Традиция человека без отметок две недели, о которой коуч не спрашивал две недели. */
  readonly quietRitual: { readonly id: string; readonly title: string } | null;
  readonly personalWindows: number;
  readonly familyRituals: number;
  /** Сколько областей заботы человек ведёт (принятых). Ноль значит, что о них с ним ещё не говорили. */
  readonly ownedCareAreas: number;
  /** Включён недельный обзор: он сам спрашивает про неделю, и коуч про неё молчит. */
  readonly weeklyReviewEnabled: boolean;
}

export interface CoachClock {
  readonly hour: number;
  /** 0 воскресенье, как в `Date.getDay`. */
  readonly weekday: number;
}

export interface CoachTouch {
  readonly reason: CoachReason;
  readonly subject: string | null;
  readonly text: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Раньше и позже этих часов коуч не пишет: вопрос о себе не для утра перед работой и не для ночи. */
export const COACH_FIRST_HOUR = 10;
export const COACH_LAST_HOUR = 21;
export const COACH_MIN_GAP_MS = 2 * DAY_MS;
export const COACH_WEEKLY_LIMIT = 3;
/** Повтор одного и того же повода: личное время и традиции не чаще раза в две недели. */
const SLOW_REASON_GAP_MS = 14 * DAY_MS;
const WEEK_WARM_GAP_MS = 5 * DAY_MS;
const WEEK_WARM_FIRST_HOUR = 18;

export const COACH_INVITE_TEXT = [
  "Скажу заранее: иногда, не чаще пары раз в неделю, я буду задавать один короткий вопрос не про дела.",
  "Про время для себя, про то, что порадовало или было тяжело, про ваши семейные традиции.",
  "Отвечать не обязательно. Напиши «без коуча» — не буду спрашивать,",
  "«не пиши мне первым» — замолчу совсем.",
  "По воскресеньям вечером буду присылать разбор недели, если есть что пересмотреть; «хватит обзоров» выключит его.",
].join(" ");

function quote(title: string): string {
  const clean = title.replace(/\s+/gu, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
}

function olderThan(at: Date | undefined, gap: number, now: Date): boolean {
  return at === undefined || now.getTime() - at.getTime() >= gap;
}

export function chooseCoachTouch(facts: CoachFacts, clock: CoachClock, now: Date): CoachTouch | null {
  if (facts.enabled === false) return null;
  if (clock.hour < COACH_FIRST_HOUR || clock.hour >= COACH_LAST_HOUR) return null;
  // Объявление уходит один раз и без вопроса; после него `null` значит то же, что `true`.
  if (facts.enabled === null && !facts.invited) {
    return { reason: "invite", subject: null, text: COACH_INVITE_TEXT };
  }
  if (facts.lastTouchAt !== null && now.getTime() - facts.lastTouchAt.getTime() < COACH_MIN_GAP_MS) return null;
  if (facts.touchesLastWeek >= COACH_WEEKLY_LIMIT) return null;

  // Отношения с супругом и с родителем разные: вопрос про традицию вдвоём обращён к партнёру, и
  // маме он не адресован вовсе. Пока родство не названо, задаются только нейтральные вопросы.
  const partner = facts.relation === "partner";
  if (facts.openDecision) {
    const { id, proposer, title } = facts.openDecision;
    return {
      reason: "decision_open", subject: id,
      text: `${proposer} предлагает: «${quote(title)}». Ты за, против или хочется обсудить? `
        + "Решаешь только ты, молчание я согласием не считаю.",
    };
  }
  // Забота раньше традиций: событие устаревает за дни, а традиция подождёт.
  if (facts.openSituation) {
    const { id, text } = facts.openSituation;
    return {
      reason: "situation_followup", subject: id,
      text: `Ты писал: «${quote(text)}». Чем кончилось, как ты сейчас? `
        + "Если не хочется это обсуждать, так и скажи, спрашивать не буду.",
    };
  }
  if (partner && facts.quietRitual) {
    const { id, title } = facts.quietRitual;
    return {
      reason: "ritual_checkin", subject: id,
      text: `Как «${quote(title)}» — получалось в последнее время? `
        + "Можно отметить, пропустить или снять традицию, ничего не горит.",
    };
  }
  // Недельный обзор задаёт «что помогло» и «что давит» в тот же воскресный вечер. Два вопроса про
  // одну неделю подряд это уже рассылка, поэтому тёплый вопрос уступает обзору целиком.
  const weekEnd = !facts.weeklyReviewEnabled && (clock.weekday === 5 || clock.weekday === 0);
  if (weekEnd && clock.hour >= WEEK_WARM_FIRST_HOUR && olderThan(facts.lastByReason.week_warm, WEEK_WARM_GAP_MS, now)) {
    return {
      reason: "week_warm", subject: null,
      text: "Что на этой неделе порадовало? И если хочется, одно, что было тяжело.",
    };
  }
  // Fair Play: область ведут целиком и по своей воле. Спрашивается только о факте, что у человека
  // нет ни одной, дела и нагрузка не читаются и не считаются.
  if (facts.ownedCareAreas === 0 && olderThan(facts.lastByReason.care_area_offer, SLOW_REASON_GAP_MS, now)) {
    return {
      reason: "care_area_offer", subject: null,
      text: "Есть направление, которое ты ведёшь целиком: садик, машина, врачи, платежи? Назови одно, "
        + "запишу как твою область, и всё, что к ней относится, будет приходить к тебе. "
        + "Если пока нет, так и скажи.",
    };
  }
  // Личное время это не только тишина: вопрос про желание, потом про время (Unicorn Space).
  if (facts.personalWindows === 0 && olderThan(facts.lastByReason.rest_window_missing, SLOW_REASON_GAP_MS, now)) {
    return {
      reason: "rest_window_missing", subject: null,
      text: "Если бы у тебя был час только для себя, что бы ты в нём сделал? И когда он мог бы быть? "
        + "Назови день и время, поставлю окно личного времени, и в него я писать не буду.",
    };
  }
  if (partner && facts.familyRituals === 0 && olderThan(facts.lastByReason.ritual_none, SLOW_REASON_GAP_MS, now)) {
    return {
      reason: "ritual_none", subject: null,
      text: "Есть что-то маленькое, что хочется делать вместе регулярно: чай без телефонов, "
        + "прогулка, семейный ужин? Запишу как традицию, без обязательств и отчётов.",
    };
  }
  return null;
}
