/**
 * The family's monthly budget before a turn (migration 181).
 *
 * Constructs covered:
 * - Within the budget the turn goes on.
 * - Past it the first message hears the notice once and starts no turn; later ones are silent.
 * - An answer to a confirmation the bot already asked is not stopped by the budget.
 */
import { describe, expect, it } from "vitest";

import { FAMILY_BUDGET_NOTICE } from "./family-budget-repository.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";
import { privateMessage, repositories, telegramContext } from "./telegram-on-message.test-fixtures.js";

const FAMILY = "0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

function familyRepositories() {
  const repository = repositories();
  repository.telegram.findIdentity.mockResolvedValue({ familyId: FAMILY, role: "owner", userId: "user-1" });
  repository.telegram.hasOwner.mockResolvedValue(true);
  const conversation = repository.conversations.getByChatId.getMockImplementation();
  repository.conversations.getByChatId.mockImplementation(async (...args: unknown[]) =>
    ({ ...(await (conversation as (...a: unknown[]) => Promise<object>)(...args)), familyId: FAMILY }));
  return repository;
}

describe("family budget gate", () => {
  it("lets a family within its budget start the turn", async () => {
    const repository = familyRepositories();
    const telegram = telegramContext();
    await createTelegramMessageHandler(repository)(telegram.context, privateMessage("Привет"));
    expect(repository.familyBudget.budgetGate).toHaveBeenCalledWith({ familyId: FAMILY, now: expect.any(Date) });
    expect(repository.session.prepareTurn).toHaveBeenCalled();
  });

  it("tells the family once that the month's budget is spent, then stays silent", async () => {
    const repository = familyRepositories();
    repository.familyBudget.budgetGate.mockResolvedValueOnce("notify").mockResolvedValueOnce("silent");
    const telegram = telegramContext();
    const handler = createTelegramMessageHandler(repository);

    await expect(handler(telegram.context, privateMessage("Привет"))).resolves.toBeNull();
    await expect(handler(telegram.context, { ...privateMessage("Ау"), messageId: "2" })).resolves.toBeNull();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith(FAMILY_BUDGET_NOTICE);
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it("lets an answer to a pending confirmation through", async () => {
    const repository = familyRepositories();
    repository.familyBudget.budgetGate.mockResolvedValue("silent");
    repository.hitl.authorizeReply.mockResolvedValue("authorized");
    const telegram = telegramContext();
    const answer = {
      ...privateMessage("Нет"),
      replyToMessage: {
        chat: { id: "telegram-101", type: "private" as const },
        from: { firstName: "Шуша", id: "bot-1", isBot: true, username: "osinara_bot" },
        messageId: "50",
        text: "Удалить напоминание?",
      },
    };
    await createTelegramMessageHandler(repository)(telegram.context, answer as never);
    expect(repository.hitl.authorizeReply).toHaveBeenCalled();
    expect(repository.familyBudget.budgetGate).not.toHaveBeenCalled();
  });
});
