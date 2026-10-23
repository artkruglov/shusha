/**
 * Утренний обзор.
 *
 * Проверяется: ночью молчит, выключенный не приходит, пустой день не тратит ни предел, ни заявку,
 * дважды за сутки не уходит, неудачная доставка заявку не возвращает;
 * отправленный обзор попадает в журнал доставок личного чата.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDailyOverviewDispatcher,
  type DailyOverviewRecipient,
} from "./daily-overview-dispatch.js";
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";

const person: DailyOverviewRecipient = {
  familyId: "family-1",
  firstEver: false,
  overviewEnabled: true,
  overviewHour: null,
  settings: { dailyLimit: 3, enabled: true, quietEnd: "08:00", quietStart: "23:00", timezone: "Europe/Moscow" },
  state: { sentToday: 0, unanswered: 0 },
  telegramUserId: "101",
  userId: "user-1",
};
const morning = new Date("2026-09-12T06:10:00.000Z");
const KEYBOARD = { inline_keyboard: [[{ callback_data: "tb:1", text: "✓ Оплатить счёт" }]] };

function dependencies(overrides: Partial<Parameters<typeof createDailyOverviewDispatcher>[0]> = {}) {
  return {
    claim: vi.fn().mockResolvedValue("ref-1"),
    keyboard: vi.fn().mockResolvedValue(KEYBOARD),
    record: vi.fn().mockResolvedValue(undefined),
    recordShows: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("555"),
    personalTime: vi.fn().mockResolvedValue(null),
    overview: vi.fn().mockResolvedValue({
      now: new Date("2026-09-22T06:00:00Z"), timezone: "UTC", waiting: [],
      tasks: [{ dueAt: null, dueOn: "2026-09-20", kind: "task", listName: null, source: "Семья", status: "accepted", title: "Оплатить счёт" }],
    }),
    recipients: vi.fn().mockResolvedValue([person]),
    ...overrides,
  };
}

describe("createDailyOverviewDispatcher", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the morning overview to the person's own chat", async () => {
    const deps = dependencies();
    await expect(createDailyOverviewDispatcher(deps)(morning)).resolves.toBe(1);
    expect(deps.send).toHaveBeenCalledWith({
      chatId: "101", entities: expect.arrayContaining([{ length: 12, offset: 0, type: "bold" }]), replyMarkup: KEYBOARD,
      text: expect.stringContaining("Оплатить счёт"),
    });
    expect(deps.keyboard).toHaveBeenCalledWith(person, expect.objectContaining({ openCount: 1 }), morning);
    // Показ этого утра записан: после трёх таких обзор перестанет повторять дело.
    expect(deps.recordShows).toHaveBeenCalledWith(person, [expect.objectContaining({ title: "Оплатить счёт" })], "2026-09-12");
  });

  it("still counts the overview as sent when recording its shows fails", async () => {
    const deps = dependencies({ recordShows: vi.fn().mockRejectedValue(new Error("down")) });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(createDailyOverviewDispatcher(deps)(morning)).resolves.toBe(1);
    expect(deps.record).toHaveBeenCalled();
  });

  it("explains itself and names the switch the first time it ever speaks", async () => {
    const deps = dependencies({
      recipients: vi.fn().mockResolvedValue([{ ...person, firstEver: true }]),
    });
    await createDailyOverviewDispatcher(deps)(morning);
    expect(deps.send).toHaveBeenCalledWith({
      chatId: "101", entities: expect.any(Array), replyMarkup: KEYBOARD, text: expect.stringContaining("не пиши мне первым"),
    });
    // Второй раз объяснение не повторяется: человек его уже прочитал.
    const later = dependencies({ send: vi.fn().mockResolvedValue("556") });
    await createDailyOverviewDispatcher(later)(morning);
    expect(later.send).toHaveBeenCalledWith({
      chatId: "101", entities: expect.any(Array), replyMarkup: KEYBOARD, text: expect.not.stringContaining("не пиши мне первым"),
    });
  });

  it("keeps the person's own overview switch and hour", async () => {
    const off = dependencies({ recipients: vi.fn().mockResolvedValue([{ ...person, overviewEnabled: false }]) });
    await expect(createDailyOverviewDispatcher(off)(morning)).resolves.toBe(0);
    // 09:10 по Москве: в 10 ещё рано, в 9 уже пора.
    const ten = dependencies({ recipients: vi.fn().mockResolvedValue([{ ...person, overviewHour: 10 }]) });
    await expect(createDailyOverviewDispatcher(ten)(morning)).resolves.toBe(0);
    const nine = dependencies({ recipients: vi.fn().mockResolvedValue([{ ...person, overviewHour: 9 }]) });
    await expect(createDailyOverviewDispatcher(nine)(morning)).resolves.toBe(1);
  });

  it("keeps quiet while the person is in their own time", async () => {
    const deps = dependencies({ personalTime: vi.fn().mockResolvedValue("Зал") });
    await expect(createDailyOverviewDispatcher(deps)(morning)).resolves.toBe(0);
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it("stays quiet before the morning hour of that person", async () => {
    const deps = dependencies();
    // 04:10 по Москве: человек спит, и его тихие часы тут ни при чём.
    await expect(createDailyOverviewDispatcher(deps)(new Date("2026-09-12T01:10:00.000Z")))
      .resolves.toBe(0);
    expect(deps.overview).not.toHaveBeenCalled();
  });

  it("respects the switch and the pause without even looking at the day", async () => {
    for (const recipient of [
      { ...person, settings: { ...person.settings, enabled: false } },
      { ...person, state: { sentToday: 0, unanswered: 3 } },
      { ...person, state: { sentToday: 3, unanswered: 0 } },
    ]) {
      const deps = dependencies({ recipients: vi.fn().mockResolvedValue([recipient]) });
      await expect(createDailyOverviewDispatcher(deps)(morning)).resolves.toBe(0);
      expect(deps.overview).not.toHaveBeenCalled();
      expect(deps.claim).not.toHaveBeenCalled();
    }
  });

  it("spends neither the claim nor the daily limit on a day with nothing in it", async () => {
    const deps = dependencies({
      personalTime: vi.fn().mockResolvedValue(null),
    overview: vi.fn().mockResolvedValue({ now: new Date("2026-09-22T06:00:00Z"), tasks: [], timezone: "UTC", waiting: [] }),
    });
    await expect(createDailyOverviewDispatcher(deps)(morning)).resolves.toBe(0);
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("does not send a second overview in the same day", async () => {
    const deps = dependencies({ claim: vi.fn().mockResolvedValue(null) });
    await expect(createDailyOverviewDispatcher(deps)(morning)).resolves.toBe(0);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("keeps the day's claim after any failed delivery", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = dependencies({
      send: vi.fn().mockRejectedValue(
        new MemoryReviewOwnerAlertTransportError("failed", "AGENT_TELEGRAM_DELIVERY_REJECTED", "403"),
      ),
    });
    await expect(createDailyOverviewDispatcher(refused)(morning)).resolves.toBe(0);
    expect(error.mock.calls[0]![0]).toContain("AGENT_DAILY_OVERVIEW_FAILED");

    const lost = dependencies({ send: vi.fn().mockRejectedValue(new Error("socket hang up")) });
    await createDailyOverviewDispatcher(lost)(morning);
    expect(lost.record).not.toHaveBeenCalled();
    expect(error.mock.calls.at(-1)![0]).toContain("AGENT_DAILY_OVERVIEW_AMBIGUOUS");
  });

  it("puts the sent overview into the chat's delivery journal so the reply turn sees it", async () => {
    const deps = dependencies();
    await createDailyOverviewDispatcher(deps)(morning);
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      deliveryRef: "ref-1", messageId: "555", sourceKind: "daily_overview",
      telegramUserId: "101", text: expect.stringContaining("Оплатить счёт"), userId: "user-1",
    }));
  });

  it("keeps a sent overview sent when the journal write fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies({ record: vi.fn().mockRejectedValue(new Error("db down")) });
    await expect(createDailyOverviewDispatcher(deps)(morning)).resolves.toBe(1);
    expect(error.mock.calls[0]![0]).toContain("AGENT_INITIATIVE_DELIVERY_RECORD_FAILED");
  });
});
