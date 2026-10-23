/**
 * Guest answer orchestration (Bot API 10.0).
 *
 * Constructs covered:
 * - The bot mention is stripped and the quoted message reaches the model as data.
 * - Every answer carries the private-chat button with the guest start payload.
 * - A caller over the daily ceiling gets the ceiling text without a model call.
 * - A bare mention gets the introduction without a model call and without spending the quota.
 * - A failed generation still answers with a failure text and returns the quota slot.
 * - The answer and its title are cut on code points, never inside an emoji.
 * - The chat's notes reach the model; directives are applied for the chat of the update and never
 *   shown; a reminder offer adds the «Напомнить и мне» button.
 * - A directive that was dropped or pointed past the list is admitted in the answer.
 * - A rejected answer with the reminder button goes out once more without it.
 * - A bot caller gets no answer at all.
 * - The answer log records how many searches the provider ran and how many failed.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { clipCodePoints, createGuestAnswerer, type GuestAnswerDependencies } from "./guest-answer.js";
import type { GuestMessage } from "./guest-message.js";

function guestRaw(overrides: Record<string, unknown> = {}) {
  return {
    chat: { id: 501, type: "private" },
    date: 1_700_000_000,
    from: { first_name: "Артём", id: 101, is_bot: false },
    guest_query_id: "guest-1",
    message_id: 9,
    text: "@Shusha_Bot сколько стоит билет в Третьяковку?",
    ...overrides,
  };
}

function dependencies() {
  return {
    agentName: "Шуша",
    answer: vi.fn().mockResolvedValue(undefined),
    botUsername: "shusha_bot",
    claimQuota: vi.fn().mockResolvedValue("allowed"),
    generate: vi.fn<GuestAnswerDependencies["generate"]>()
      .mockResolvedValue({ searchErrors: 0, searches: 1, text: "Взрослый билет 1000 ₽." }),
    applyActions: vi.fn<GuestAnswerDependencies["applyActions"]>().mockResolvedValue({ offerId: null, skipped: 0 }),
    releaseQuota: vi.fn().mockResolvedValue(undefined),
    summon: vi.fn<GuestAnswerDependencies["summon"]>().mockResolvedValue([]),
  };
}

describe("createGuestAnswerer", () => {
  it("answers the question without the mention and with the private-chat button", async () => {
    const deps = dependencies();
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await createGuestAnswerer(deps)(guestRaw({
      reply_to_message: { from: { first_name: "Илья" }, message_id: 8, text: "Пойдём в субботу?" },
    }), "2001");

    const message = deps.generate.mock.calls[0]![1] as GuestMessage;
    expect(message.question).toBe("сколько стоит билет в Третьяковку?");
    expect(message.quoted).toMatchObject({ author: "Илья", fromSelf: false, text: "Пойдём в субботу?" });
    expect(deps.claimQuota).toHaveBeenCalledWith("101");
    expect(deps.answer).toHaveBeenCalledWith({
      buttonText: "Открыть Шуша",
      buttonUrl: "https://t.me/shusha_bot?start=g",
      queryId: "guest-1",
      reminderOfferId: null,
      text: "Взрослый билет 1000 ₽.",
    });
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({
      code: "AGENT_GUEST_ANSWERED",
      searchErrors: 0,
      searches: 1,
    });
    log.mockRestore();
  });

  it("answers over the ceiling without calling the model", async () => {
    const deps = dependencies();
    deps.claimQuota.mockResolvedValue("caller_limit");

    await createGuestAnswerer(deps)(guestRaw(), "2001");

    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.answer).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("закончились"),
    }));
  });

  it("introduces itself on a bare mention without calling the model", async () => {
    const deps = dependencies();

    await createGuestAnswerer(deps)(guestRaw({ text: "@shusha_bot" }), "2001");

    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.claimQuota).not.toHaveBeenCalled();
    expect(deps.answer).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Я Шуша") }));
  });

  it("never answers another bot", async () => {
    const deps = dependencies();

    await createGuestAnswerer(deps)(guestRaw({ from: { first_name: "Bot", id: 7, is_bot: true } }), "2001");

    expect(deps.claimQuota).not.toHaveBeenCalled();
    expect(deps.answer).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty model answer", () => Promise.resolve({ searchErrors: 0, searches: 1, text: "  " })],
    ["a model failure", () => Promise.reject(new Error("timeout"))],
  ])("answers %s with a failure text and returns the quota slot", async (_name, generate) => {
    const deps = dependencies();
    deps.generate.mockImplementation(generate);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createGuestAnswerer(deps)(guestRaw(), "2001");

    expect(deps.releaseQuota).toHaveBeenCalledWith("101");
    expect(deps.answer).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Не получилось") }));
    expect(JSON.parse(String(error.mock.calls[0]![0]))).toMatchObject({ code: "AGENT_GUEST_ANSWER_FAILED" });
    error.mockRestore();
  });

  it("applies the answer's directives to the summoning chat and offers the reminder button", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-11T19:00:00Z"), toFake: ["Date"] });
    const deps = dependencies();
    const notes = [{ content: "Падл с Максимом", done: false, dueOn: null, id: "n1" }];
    deps.summon.mockResolvedValue(notes);
    deps.generate.mockResolvedValue({
      searchErrors: 0,
      searches: 0,
      text: 'Записала и сделала кнопку на 15-е.\n<guest-remember due="2026-10-16">Физтехи</guest-remember>' +
        '<guest-reminder at="2026-10-15 10:00">Завтра физтехи</guest-reminder>',
    });
    deps.applyActions.mockResolvedValue({ offerId: "offer-1", skipped: 0 });

    await createGuestAnswerer(deps)(guestRaw({ text: "@shusha_bot запомни физтехи 16-го и напомни нам 15-го" }), "2001");

    expect(deps.summon).toHaveBeenCalledWith("p:101:501");
    expect(deps.generate.mock.calls[0]![2]).toBe(notes);
    expect(deps.applyActions).toHaveBeenCalledWith({
      actions: [
        { content: "Физтехи", dueOn: "2026-10-16", type: "remember" },
        { content: "Завтра физтехи", runAt: new Date("2026-10-15T07:00:00Z"), type: "reminder" },
      ],
      authorTelegramUserId: "101",
      chatKey: "p:101:501",
      shown: notes,
    });
    expect(deps.answer).toHaveBeenCalledWith(expect.objectContaining({
      reminderOfferId: "offer-1",
      text: "Записала и сделала кнопку на 15-е.",
    }));
    vi.useRealTimers();
  });

  it("admits in the answer that part of the request was not saved", async () => {
    const deps = dependencies();
    deps.generate.mockResolvedValue({ searchErrors: 0, searches: 0, text: 'Отметила.<guest-done n="7"/>' });
    deps.applyActions.mockResolvedValue({ offerId: null, skipped: 1 });

    await createGuestAnswerer(deps)(guestRaw({ text: "@shusha_bot отметь седьмое" }), "2001");

    expect(deps.answer).toHaveBeenCalledWith(expect.objectContaining({
      text: "Отметила.\n\nЧасть просьбы я не смогла записать, повторите её, пожалуйста.",
    }));
  });

  it("sends the answer without the reminder button when Telegram rejects it", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-11T19:00:00Z"), toFake: ["Date"] });
    const deps = dependencies();
    deps.generate.mockResolvedValue({
      searchErrors: 0,
      searches: 0,
      text: 'Кнопка ниже.<guest-reminder at="2026-10-15 10:00">Физтехи</guest-reminder>',
    });
    deps.applyActions.mockResolvedValue({ offerId: "offer-1", skipped: 0 });
    deps.answer.mockRejectedValueOnce(new AppError("AGENT_GUEST_ANSWER_REJECTED", "Telegram отклонил гостевой ответ (HTTP 400)"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createGuestAnswerer(deps)(guestRaw({ text: "@shusha_bot напомни нам 15-го" }), "2001");

    expect(deps.answer).toHaveBeenCalledTimes(2);
    expect(deps.answer.mock.calls[1]![0]).toMatchObject({ reminderOfferId: null, text: "Кнопка ниже." });
    expect(JSON.parse(String(error.mock.calls[0]![0]))).toMatchObject({ code: "AGENT_GUEST_REMINDER_BUTTON_REJECTED" });
    error.mockRestore();
    vi.useRealTimers();
  });

  it("does not read the chat's notes for a bare mention", async () => {
    const deps = dependencies();

    await createGuestAnswerer(deps)(guestRaw({ text: "@shusha_bot" }), "2001");

    expect(deps.summon).not.toHaveBeenCalled();
  });

  it("cuts on code points so an emoji is never split", () => {
    const text = `${"а".repeat(63)}😀 дальше`;

    expect(clipCodePoints(text, 64)).toBe(`${"а".repeat(63)}😀`);
    expect(clipCodePoints("коротко", 64)).toBe("коротко");
  });
});
