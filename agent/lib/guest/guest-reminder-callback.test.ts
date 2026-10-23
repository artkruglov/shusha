/**
 * «Напомнить и мне» press handling.
 *
 * Constructs covered:
 * - Other buttons are left to their owners.
 * - A passed or forgotten offer, a person outside any family and a missing timezone each get an
 *   explanation instead of a reminder.
 * - A family member gets the reminder and its local time; a repository refusal reaches them as its
 *   own message.
 * - The confirmation fits Telegram's 200 characters; a lookup that throws is still answered.
 */
import type { TelegramCallbackQuery } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { createGuestReminderCallbackHandler, type GuestReminderCallbackDependencies } from "./guest-reminder-callback.js";

const OFFER_ID = "0b0e5a8e-3f43-4a6b-9a4e-5c1b2d3e4f50";
const offer = { content: "Встреча физтехов", id: OFFER_ID, runAt: new Date("2026-10-15T07:00:00Z") };
const identity = { familyId: "f1", role: "member" as const, userId: "u1" };

function press(data: string): TelegramCallbackQuery {
  return { data, from: { id: "9202", isBot: false }, id: "cb-1", raw: {} };
}

function dependencies() {
  return {
    answer: vi.fn<GuestReminderCallbackDependencies["answer"]>().mockResolvedValue(undefined),
    createReminder: vi.fn<GuestReminderCallbackDependencies["createReminder"]>().mockResolvedValue("2026-10-15 в 10:00"),
    findIdentity: vi.fn<GuestReminderCallbackDependencies["findIdentity"]>().mockResolvedValue(identity),
    findOffer: vi.fn<GuestReminderCallbackDependencies["findOffer"]>().mockResolvedValue(offer),
  };
}

describe("guest reminder callback", () => {
  it("leaves other buttons alone", async () => {
    const deps = dependencies();

    await expect(createGuestReminderCallbackHandler(deps)(press("su:a:token-token-token"))).resolves.toBe(false);
    expect(deps.answer).not.toHaveBeenCalled();
  });

  it("creates the presser's reminder and tells them when", async () => {
    const deps = dependencies();
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(createGuestReminderCallbackHandler(deps)(press(`gr:${OFFER_ID}`))).resolves.toBe(true);

    expect(deps.findIdentity).toHaveBeenCalledWith("9202");
    expect(deps.createReminder).toHaveBeenCalledWith({ identity, offer, telegramUserId: "9202" });
    expect(deps.answer).toHaveBeenCalledWith({
      callbackQueryId: "cb-1",
      showAlert: false,
      text: "Напомню вам в личном чате 2026-10-15 в 10:00: Встреча физтехов",
    });
  });

  it.each([
    ["a passed offer", (deps: ReturnType<typeof dependencies>) => deps.findOffer.mockResolvedValue(null), "не действует"],
    ["a person outside any family", (deps: ReturnType<typeof dependencies>) => deps.findIdentity.mockResolvedValue(null), "участникам семьи"],
    ["a missing timezone", (deps: ReturnType<typeof dependencies>) => deps.createReminder.mockResolvedValue(null), "часовой пояс"],
    ["a repository refusal", (deps: ReturnType<typeof dependencies>) =>
      deps.createReminder.mockRejectedValue(new AppError("AGENT_SPACE_CONTEXT_REQUIRED", "Область разговора не подтверждена")),
    "Область разговора не подтверждена"],
  ])("explains %s with an alert", async (_name, arrange, text) => {
    const deps = dependencies();
    arrange(deps);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createGuestReminderCallbackHandler(deps)(press(`gr:${OFFER_ID}`));

    expect(deps.answer).toHaveBeenCalledWith(expect.objectContaining({ showAlert: true, text: expect.stringContaining(text) }));
  });

  it("treats malformed button data as a passed offer", async () => {
    const deps = dependencies();

    await createGuestReminderCallbackHandler(deps)(press("gr:not-an-id"));

    expect(deps.findOffer).not.toHaveBeenCalled();
    expect(deps.answer).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("не действует") }));
  });

  it("keeps the confirmation within Telegram's 200 characters", async () => {
    const deps = dependencies();
    deps.findOffer.mockResolvedValue({ ...offer, content: "😀".repeat(400) });
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await createGuestReminderCallbackHandler(deps)(press(`gr:${OFFER_ID}`));

    const text = deps.answer.mock.calls[0]![0].text;
    expect(Array.from(text)).toHaveLength(200);
    expect(text.endsWith("…")).toBe(true);
  });

  it("answers a press whose lookup throws instead of leaving it failed", async () => {
    const deps = dependencies();
    deps.findIdentity.mockRejectedValue(new Error("connection reset"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(createGuestReminderCallbackHandler(deps)(press(`gr:${OFFER_ID}`))).resolves.toBe(true);

    expect(deps.createReminder).not.toHaveBeenCalled();
    expect(deps.answer).toHaveBeenCalledWith(expect.objectContaining({ showAlert: true, text: expect.stringContaining("Не получилось") }));
  });
});
