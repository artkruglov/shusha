import type { TelegramCallbackQuery } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { createStaleTaskTurn } from "./stale-task-turn.js";
import type { TaskButtonRow } from "./task-button-repository.js";

const ROW_ID = "11111111-1111-4111-8111-111111111111";
const row = (extra: Partial<TaskButtonRow> = {}): TaskButtonRow => ({
  action: "help_start", chatId: "700101", familyId: "33333333-3333-4333-8333-333333333333", id: ROW_ID, recipientTelegramId: "700101", settled: false,
  boardQuery: null, settingValue: null, targetGroupId: null, tipNumber: null, taskId: "22222222-2222-4222-8222-222222222222", taskVersion: 3, ...extra,
});
const AUTH = { familyId: "33333333-3333-4333-8333-333333333333", userId: "user-1" } as never;

function query(chatType: "group" | "private" = "private"): TelegramCallbackQuery {
  const chat = { id: chatType === "private" ? 700101 : -100, type: chatType };
  return {
    data: `tb:${ROW_ID}`,
    from: { id: "700101", isBot: false },
    id: "q-1",
    message: { chat: { id: String(chat.id), type: chatType }, messageId: "77" },
    raw: {
      from: { first_name: "Артём", id: 700101, is_bot: false },
      message: { chat, message_id: 77, reply_markup: { inline_keyboard: [[{ callback_data: `tb:${ROW_ID}`, text: "Помоги начать" }]] } },
    },
  };
}

function dependencies(found: TaskButtonRow | null = row()) {
  return {
    authorize: vi.fn().mockResolvedValue({ allowed: true, auth: AUTH }),
    find: vi.fn().mockResolvedValue(found),
    modelAvailable: vi.fn().mockResolvedValue(true),
    now: () => new Date("2026-10-21T09:00:00Z"),
    settleMessage: vi.fn().mockResolvedValue(undefined),
    spend: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue("Договориться  о встрече"),
  };
}

describe("«Помоги начать» becomes the presser's own message", () => {
  it("turns the press into a private message with a text built from the task, and spends the buttons", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies();
    const update = await createStaleTaskTurn(deps)(query());

    expect(update?.kind).toBe("message");
    if (update?.kind !== "message") return;
    expect(update.message.text).toBe("Помоги начать дело «Договориться о встрече»");
    expect(update.message.from?.id).toBe("700101");
    expect(update.message.chat).toMatchObject({ id: "700101", type: "private" });
    expect(deps.title).toHaveBeenCalledWith(AUTH, "22222222-2222-4222-8222-222222222222");
    expect(deps.spend).toHaveBeenCalledWith(row(), [ROW_ID]);
    expect(deps.settleMessage).toHaveBeenCalled();
  });

  it("leaves every other press to the button handler", async () => {
    await expect(createStaleTaskTurn(dependencies(row({ action: "keep" })))(query())).resolves.toBeNull();
    await expect(createStaleTaskTurn(dependencies(row({ settled: true })))(query())).resolves.toBeNull();
    await expect(createStaleTaskTurn(dependencies(null))(query())).resolves.toBeNull();
    await expect(createStaleTaskTurn(dependencies())(query("group"))).resolves.toBeNull();
    const refused = dependencies();
    refused.authorize.mockResolvedValue({ allowed: false, reason: "not_for_you" });
    await expect(createStaleTaskTurn(refused)(query())).resolves.toBeNull();
    expect(refused.spend).not.toHaveBeenCalled();
    await expect(createStaleTaskTurn(dependencies())({ ...query(), data: "gj:x" })).resolves.toBeNull();
    // Past the family's model budget the press stays a button: nothing is spent, the handler explains.
    const spent = dependencies();
    spent.modelAvailable.mockResolvedValue(false);
    await expect(createStaleTaskTurn(spent)(query())).resolves.toBeNull();
    expect(spent.spend).not.toHaveBeenCalled();
    // A task gone out of reach: no turn, nothing spent.
    const gone = dependencies();
    gone.title.mockRejectedValue(new Error("AGENT_TASK_ACCESS_DENIED"));
    await expect(createStaleTaskTurn(gone)(query())).resolves.toBeNull();
    expect(gone.spend).not.toHaveBeenCalled();
  });
});
