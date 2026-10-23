import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import { createStaleTaskDispatcher } from "./stale-task-dispatch.js";
import type { StaleTaskRecipient } from "./stale-task-repository.js";

const person = {
  familyId: "family-1", telegramUserId: "101", userId: "user-1",
  settings: { dailyLimit: 3, enabled: true, quietEnd: "08:00", quietStart: "23:00", timezone: "Europe/Moscow" },
  state: { sentToday: 0, unanswered: 0 },
} as unknown as StaleTaskRecipient;
const noon = new Date("2026-10-21T09:00:00Z");
const task = { id: "t1", since: "2026-09-15", title: "Договориться о встрече", version: 3 };
const KEYBOARD = { inline_keyboard: [[{ callback_data: "tb:1", text: "Помоги начать" }]] };

function dependencies(overrides: Partial<Parameters<typeof createStaleTaskDispatcher>[0]> = {}) {
  return {
    candidate: vi.fn().mockResolvedValue(task),
    claim: vi.fn().mockResolvedValue("ref-1"),
    keyboard: vi.fn().mockResolvedValue(KEYBOARD),
    personalTime: vi.fn().mockResolvedValue(null),
    recipients: vi.fn().mockResolvedValue([person]),
    record: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("555"),
    ...overrides,
  };
}

describe("createStaleTaskDispatcher", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes once about the task, with its buttons, and records the delivery", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies();
    await expect(createStaleTaskDispatcher(deps)(noon)).resolves.toBe(1);
    expect(deps.claim).toHaveBeenCalledWith(person, "2026-10-21", task, noon);
    expect(deps.send).toHaveBeenCalledWith({
      chatId: "101", replyMarkup: KEYBOARD, text: "«Договориться о встрече» не менялось с 15 сентября. Что с ним сделаем?",
    });
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ messageId: "555", sourceKind: "stale_task" }));
  });

  it("stays silent without a candidate, in personal time, at night and when the day is already claimed", async () => {
    const none = dependencies({ candidate: vi.fn().mockResolvedValue(null) });
    await expect(createStaleTaskDispatcher(none)(noon)).resolves.toBe(0);
    expect(none.claim).not.toHaveBeenCalled();
    const busy = dependencies({ personalTime: vi.fn().mockResolvedValue("Зал") });
    await expect(createStaleTaskDispatcher(busy)(noon)).resolves.toBe(0);
    const night = dependencies();
    await expect(createStaleTaskDispatcher(night)(new Date("2026-10-21T22:00:00Z"))).resolves.toBe(0);
    expect(night.candidate).not.toHaveBeenCalled();
    const claimed = dependencies({ claim: vi.fn().mockResolvedValue(null) });
    await expect(createStaleTaskDispatcher(claimed)(noon)).resolves.toBe(0);
    expect(claimed.send).not.toHaveBeenCalled();
  });

  it("does not resend after a refused delivery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies({ send: vi.fn().mockRejectedValue(new MemoryReviewOwnerAlertTransportError("failed", "AGENT_TELEGRAM_BLOCKED", "blocked")) });
    await expect(createStaleTaskDispatcher(deps)(noon)).resolves.toBe(0);
    expect(deps.record).not.toHaveBeenCalled();
  });
});
