/**
 * `/feedback` before Eve.
 *
 * Constructs covered:
 * - A member's text goes to the operator with the family's ordinal and the sender's name; the sender hears thanks.
 * - An empty command explains itself, a person without a family or a group chat is not handled here.
 * - Over the daily limit nothing is sent; a refused delivery keeps the text and says so.
 * - Writing the command counts as the person's answer to a question the bot started.
 */
import { describe, expect, it, vi } from "vitest";

import { handleFeedbackCommand, type FeedbackRepository } from "./telegram-feedback-command.js";
import { groupMessage, privateMessage, telegramContext } from "./telegram-on-message.test-fixtures.js";

const IDENTITY = { familyId: "family-2", role: "member" as const, userId: "user-2" };

function fakes(overrides: Partial<FeedbackRepository> = {}) {
  return {
    markAnswered: vi.fn(async () => undefined),
    markDelivered: vi.fn(async () => undefined),
    operatorChatId: vi.fn(async () => "telegram-1"),
    record: vi.fn(async () => ({ familyOrdinal: 2, id: "row-1" })),
    send: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("/feedback", () => {
  it("sends the text to the operator and thanks the sender", async () => {
    const repository = fakes();
    const telegram = telegramContext();
    await expect(handleFeedbackCommand(
      { ctx: telegram.context, identity: IDENTITY, message: privateMessage("/feedback не понял, как перенести дело") }, repository,
    )).resolves.toBe(true);
    expect(repository.record).toHaveBeenCalledWith(expect.objectContaining({
      familyId: "family-2", telegramUserId: "telegram-101", text: "не понял, как перенести дело",
    }));
    expect(repository.send).toHaveBeenCalledWith({ chatId: "telegram-1", text: "Отзыв, семья 2, Анна:\nне понял, как перенести дело" });
    expect(repository.markDelivered).toHaveBeenCalledWith("row-1", expect.any(Date));
    expect(telegram.sendMessage).toHaveBeenCalledWith("Спасибо, передала оператору.");
    // The answer to «что мешает» goes around Eve, so the pause after silence is lifted here.
    expect(repository.markAnswered).toHaveBeenCalledWith("user-2", expect.any(Date));
  });

  it("explains an empty command and leaves other chats and strangers to the usual path", async () => {
    const repository = fakes();
    const telegram = telegramContext();
    await handleFeedbackCommand({ ctx: telegram.context, identity: IDENTITY, message: privateMessage("/feedback") }, repository);
    expect(telegram.sendMessage.mock.calls[0]![0]).toContain("Напишите после команды");
    expect(await handleFeedbackCommand({ ctx: telegram.context, identity: null, message: privateMessage("/feedback да") }, repository)).toBe(false);
    expect(await handleFeedbackCommand({ ctx: telegram.context, identity: IDENTITY, message: groupMessage("/feedback да") }, repository)).toBe(false);
    expect(await handleFeedbackCommand({ ctx: telegram.context, identity: IDENTITY, message: privateMessage("отзыв") }, repository)).toBe(false);
    expect(repository.record).not.toHaveBeenCalled();
  });

  it("stops at the daily limit and keeps a text Telegram refused", async () => {
    const limited = fakes({ record: vi.fn(async () => null) });
    const telegram = telegramContext();
    await handleFeedbackCommand({ ctx: telegram.context, identity: IDENTITY, message: privateMessage("/feedback ещё") }, limited);
    expect(limited.send).not.toHaveBeenCalled();
    expect(telegram.sendMessage.mock.calls[0]![0]).toContain("За сегодня уже 5");

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = fakes({ send: vi.fn(async () => { throw new Error("HTTP 403"); }) });
    await handleFeedbackCommand({ ctx: telegram.context, identity: IDENTITY, message: privateMessage("/feedback ещё") }, refused);
    expect(refused.markDelivered).not.toHaveBeenCalled();
    expect(telegram.sendMessage.mock.calls.at(-1)![0]).toBe("Не получилось передать. Я сохранила текст, оператор его увидит.");
    expect(error.mock.calls[0]![0]).toContain("AGENT_FEEDBACK_DELIVERY_FAILED");
    error.mockRestore();
  });
});
