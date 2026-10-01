/** Коуч пишет только по поводу, объявляется один раз, выключается словом человека и никогда не говорит о делах, сроках или счёте. */
import { describe, expect, it } from "vitest";

import { chooseCoachTouch, COACH_INVITE_TEXT, type CoachFacts } from "./coach.js";

const NOW = new Date("2026-09-25T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const facts = (extra: Partial<CoachFacts> = {}): CoachFacts => ({
  enabled: true, familyRituals: 1, invited: true, invitesSent: 1, lastByReason: {}, lastTouchAt: null, ownedCareAreas: 1,
  openDecision: null, openSituation: null, personalWindows: 1, quietRitual: null, relation: "partner", touchesLastWeek: 0,
  weeklyReviewEnabled: false, ...extra,
});
const afternoon = { hour: 15, weekday: 3 };

describe("coach touch", () => {
  it("announces itself once, and after that silence means yes", () => {
    // Пока нужно было явное «да», коуч молчал у всех: «да» никто не сказал (29 сентября 2026).
    expect(chooseCoachTouch(facts({ enabled: null, invited: false, invitesSent: 0 }), afternoon, NOW))
      .toEqual({ reason: "invite", subject: null, text: COACH_INVITE_TEXT });
    // Объявление уже было, ответа нет: коуч работает как включённый и ищет повод.
    const announced = facts({ enabled: null, invited: true, lastByReason: { invite: ago(3) }, personalWindows: 0 });
    expect(chooseCoachTouch(announced, afternoon, NOW)?.reason).toBe("rest_window_missing");
    expect(COACH_INVITE_TEXT).toContain("без коуча");
    expect(COACH_INVITE_TEXT).not.toMatch(/можно я|скажи «да»/iu);
  });

  it("never revives a coach the person turned off", () => {
    expect(chooseCoachTouch(facts({ enabled: false, personalWindows: 0 }), afternoon, NOW)).toBeNull();
    expect(chooseCoachTouch(facts({ enabled: false, invited: false, invitesSent: 0 }), afternoon, NOW)).toBeNull();
  });

  it("keeps two days between the announcement and the first question", () => {
    const fresh = facts({ enabled: null, invited: true, lastTouchAt: ago(1), lastByReason: { invite: ago(1) }, personalWindows: 0 });
    expect(chooseCoachTouch(fresh, afternoon, NOW)).toBeNull();
  });

  it("asks how a recorded personal event ended, once, before rituals", () => {
    const touch = chooseCoachTouch(facts({
      openSituation: { id: "m1", text: "Завтра иду к врачу с больной спиной" }, quietRitual: { id: "r1", title: "Прогулка" },
    }), afternoon, NOW)!;
    expect(touch).toMatchObject({ reason: "situation_followup", subject: "m1" });
    expect(touch.text).toContain("Завтра иду к врачу");
    expect(touch.text).toContain("спрашивать не буду");
  });

  it("stays silent without a reason: the ceiling is not a schedule", () => {
    expect(chooseCoachTouch(facts(), afternoon, NOW)).toBeNull();
  });

  it("keeps two days between touches and three a week", () => {
    const due = facts({ personalWindows: 0 });
    expect(chooseCoachTouch({ ...due, lastTouchAt: ago(1) }, afternoon, NOW)).toBeNull();
    expect(chooseCoachTouch({ ...due, touchesLastWeek: 3, lastTouchAt: ago(2) }, afternoon, NOW)).toBeNull();
    expect(chooseCoachTouch({ ...due, lastTouchAt: ago(2) }, afternoon, NOW)?.reason).toBe("rest_window_missing");
  });

  it("writes neither early in the morning nor at night", () => {
    const due = facts({ enabled: null, invited: false, invitesSent: 0 });
    expect(chooseCoachTouch(due, { hour: 9, weekday: 3 }, NOW)).toBeNull();
    expect(chooseCoachTouch(due, { hour: 21, weekday: 3 }, NOW)).toBeNull();
  });

  it("asks about the partner's proposal first and says silence is not consent", () => {
    const touch = chooseCoachTouch(facts({
      openDecision: { id: "d1", proposer: "Саша", title: "Чай без телефонов по воскресеньям" },
      personalWindows: 0, quietRitual: { id: "r1", title: "Прогулка" },
    }), afternoon, NOW)!;

    expect(touch).toMatchObject({ reason: "decision_open", subject: "d1" });
    expect(touch.text).toContain("Саша предлагает: «Чай без телефонов по воскресеньям»");
    expect(touch.text).toContain("молчание я согласием не считаю");
  });

  it("offers to skip or drop a quiet tradition instead of counting misses", () => {
    const touch = chooseCoachTouch(facts({ quietRitual: { id: "r1", title: "Воскресный чай" } }), afternoon, NOW)!;

    expect(touch).toMatchObject({ reason: "ritual_checkin", subject: "r1" });
    expect(touch.text).toContain("пропустить или снять");
    expect(touch.text).not.toMatch(/\d/u);
  });

  it("asks what pleased on Friday or Sunday evening, once a week", () => {
    const friday = { hour: 19, weekday: 5 };
    expect(chooseCoachTouch(facts(), friday, NOW)?.reason).toBe("week_warm");
    expect(chooseCoachTouch(facts({ lastByReason: { week_warm: ago(2) } }), friday, NOW)).toBeNull();
    expect(chooseCoachTouch(facts(), { hour: 19, weekday: 3 }, NOW)).toBeNull();
  });

  it("leaves the week to the weekly review when the person asked for it", () => {
    // Обзор спрашивает «что помогло» и «что давит» тем же вечером: второй вопрос это рассылка.
    const review = facts({ weeklyReviewEnabled: true });
    expect(chooseCoachTouch(review, { hour: 19, weekday: 0 }, NOW)).toBeNull();
    expect(chooseCoachTouch(review, { hour: 19, weekday: 5 }, NOW)).toBeNull();
    // Остальные поводы обзор не отменяет: он про дела, а не про личное время.
    expect(chooseCoachTouch(facts({ weeklyReviewEnabled: true, personalWindows: 0 }), { hour: 19, weekday: 0 }, NOW)
      ?.reason).toBe("rest_window_missing");
  });

  it("asks about own time and a first tradition at most every two weeks", () => {
    expect(chooseCoachTouch(facts({ personalWindows: 0, lastByReason: { rest_window_missing: ago(13) } }), afternoon, NOW))
      .toBeNull();
    expect(chooseCoachTouch(facts({ familyRituals: 0 }), afternoon, NOW)?.reason).toBe("ritual_none");
    expect(chooseCoachTouch(facts({ familyRituals: 0, lastByReason: { ritual_none: ago(3) } }), afternoon, NOW))
      .toBeNull();
  });

  it("never talks about tasks, deadlines or counts", () => {
    const texts = [
      chooseCoachTouch(facts({ personalWindows: 0 }), afternoon, NOW)!.text,
      chooseCoachTouch(facts({ familyRituals: 0 }), afternoon, NOW)!.text,
      chooseCoachTouch(facts(), { hour: 19, weekday: 0 }, NOW)!.text,
    ];
    for (const text of texts) expect(text).not.toMatch(/(^|\s)(дело|дела|дел)([\s,.?!]|$)|срок|просроч|\d/iu);
  });

  it("keeps couple questions for the partner and leaves a parent the neutral ones", () => {
    // Отношения с супругой и с мамой разные: традиция вдвоём маме не адресована вовсе.
    const parent = { relation: "parent" as const };
    expect(chooseCoachTouch(facts({ ...parent, quietRitual: { id: "r1", title: "Чай" } }), afternoon, NOW))
      .toBeNull();
    expect(chooseCoachTouch(facts({ ...parent, familyRituals: 0 }), afternoon, NOW)).toBeNull();
    expect(chooseCoachTouch(facts({ ...parent, personalWindows: 0 }), afternoon, NOW)?.reason)
      .toBe("rest_window_missing");
    expect(chooseCoachTouch(facts(parent), { hour: 19, weekday: 5 }, NOW)?.reason).toBe("week_warm");
    expect(chooseCoachTouch(facts({ ...parent, openDecision: { id: "d1", proposer: "Саша", title: "Поехать" } }),
      afternoon, NOW)?.reason).toBe("decision_open");
    // Пока родство не названо, парные вопросы тоже молчат.
    expect(chooseCoachTouch(facts({ relation: null, familyRituals: 0 }), afternoon, NOW)).toBeNull();
  });
  it("asks who leads a whole direction, once in two weeks, to someone who leads none", () => {
    // Прод 29 сентября 2026: областей заботы ноль, потому что никто не начинал разговор об этом.
    const none = facts({ ownedCareAreas: 0 });
    const touch = chooseCoachTouch(none, afternoon, NOW)!;

    expect(touch).toMatchObject({ reason: "care_area_offer", subject: null });
    expect(touch.text).toContain("ведёшь целиком");
    expect(touch.text).toContain("пока нет");
    expect(chooseCoachTouch(facts({ ownedCareAreas: 1 }), afternoon, NOW)).toBeNull();
    expect(chooseCoachTouch(facts({ ownedCareAreas: 0, lastByReason: { care_area_offer: ago(13) } }), afternoon, NOW)).toBeNull();
    expect(chooseCoachTouch(facts({ ownedCareAreas: 0, lastByReason: { care_area_offer: ago(14) } }), afternoon, NOW)?.reason)
      .toBe("care_area_offer");
  });

  it("asks about a direction after the week's warm question and before the free-hour question", () => {
    const friday = { hour: 19, weekday: 5 };
    const both = facts({ ownedCareAreas: 0, personalWindows: 0 });

    expect(chooseCoachTouch(both, friday, NOW)?.reason).toBe("week_warm");
    expect(chooseCoachTouch({ ...both, lastByReason: { week_warm: ago(1) } }, friday, NOW)?.reason).toBe("care_area_offer");
    expect(chooseCoachTouch({ ...both, lastByReason: { care_area_offer: ago(3) } }, afternoon, NOW)?.reason)
      .toBe("rest_window_missing");
  });

  it("asks what the person would do with an hour for themselves, not only when to stay silent", () => {
    const touch = chooseCoachTouch(facts({ personalWindows: 0 }), afternoon, NOW)!;

    expect(touch.reason).toBe("rest_window_missing");
    expect(touch.text).toMatch(/час только для себя/u);
    expect(touch.text).toMatch(/что бы ты/u);
    expect(touch.text).toContain("писать не буду");
  });

  it("tells about the weekly review in the announcement and how to stop it", () => {
    expect(COACH_INVITE_TEXT).toContain("разбор недели");
    expect(COACH_INVITE_TEXT).toContain("хватит обзоров");
  });
});
