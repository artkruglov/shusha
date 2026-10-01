/**
 * Диспетчер разбора семейных дел: не раньше утра семьи, пустой разбор не занимает заявку, один разбор
 * в сутки, отказ Telegram заявку не возвращает, отправленное попадает в журнал доставок группы.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import { createGroupOverviewDispatcher, type GroupOverviewDispatcherDependencies } from "./group-overview-dispatch.js";
import type { GroupOverviewTask } from "./group-overview.js";
import type { OverviewGroup } from "./group-overview-repository.js";

// Вторник 29 сентября 2026, 10:00 по Москве.
const NOW = new Date("2026-09-29T07:00:00Z");
const group: OverviewGroup = {
  familyId: "family-1", firstEver: false, groupId: "group-1", telegramChatId: "-1001", timezone: "Europe/Moscow",
};
const task: GroupOverviewTask = {
  assigneeName: "Юля", dueAt: null, dueOn: null, kind: "task", lifeArea: null, listName: "Дом",
  source: "Семейное", status: "accepted", title: "Забрать посылку",
};

function dependencies(overrides: Partial<GroupOverviewDispatcherDependencies> = {}) {
  return {
    claim: vi.fn().mockResolvedValue("ref-1"),
    groups: vi.fn().mockResolvedValue([group]),
    overview: vi.fn().mockResolvedValue({ now: NOW, tasks: [task], timezone: group.timezone }),
    record: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("555"),
    ...overrides,
  };
}

describe("group overview dispatcher", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts the family's tasks to the group and journals the delivery", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies();

    await expect(createGroupOverviewDispatcher(deps)(NOW)).resolves.toBe(1);

    expect(deps.claim).toHaveBeenCalledWith(group, "2026-09-29");
    expect(deps.send).toHaveBeenCalledWith({ chatId: "-1001", text: expect.stringContaining("Юля: Забрать посылку") });
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      deliveryRef: "ref-1", groupId: "group-1", messageId: "555", telegramChatId: "-1001",
    }));
  });

  it("waits for the family's morning", async () => {
    const deps = dependencies();
    // 07:00 по Москве.
    await expect(createGroupOverviewDispatcher(deps)(new Date("2026-09-29T04:00:00Z"))).resolves.toBe(0);
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it("says nothing, and keeps the day's claim free, when there is nothing to commit to", async () => {
    const deps = dependencies({ overview: vi.fn().mockResolvedValue({ now: NOW, tasks: [], timezone: group.timezone }) });

    await expect(createGroupOverviewDispatcher(deps)(NOW)).resolves.toBe(0);

    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("sends nothing when another tick already claimed the day", async () => {
    const deps = dependencies({ claim: vi.fn().mockResolvedValue(null) });

    await expect(createGroupOverviewDispatcher(deps)(NOW)).resolves.toBe(0);

    expect(deps.send).not.toHaveBeenCalled();
  });

  it("keeps the claim after a failed delivery, so a blocked group is not retried all day", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = dependencies({
      send: vi.fn().mockRejectedValue(new MemoryReviewOwnerAlertTransportError("failed", "AGENT_X", "403")),
    });
    await expect(createGroupOverviewDispatcher(refused)(NOW)).resolves.toBe(0);
    expect(refused.record).not.toHaveBeenCalled();
    expect(String(error.mock.calls[0]![0])).toContain("AGENT_GROUP_OVERVIEW_FAILED");

    const lost = dependencies({ send: vi.fn().mockRejectedValue(new Error("socket hang up")) });
    await createGroupOverviewDispatcher(lost)(NOW);
    expect(String(error.mock.calls.at(-1)![0])).toContain("AGENT_GROUP_OVERVIEW_AMBIGUOUS");
  });

  it("does not undo a delivered overview when journaling it fails", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies({ record: vi.fn().mockRejectedValue(new Error("db down")) });

    await expect(createGroupOverviewDispatcher(deps)(NOW)).resolves.toBe(1);

    expect(String(error.mock.calls[0]![0])).toContain("AGENT_INITIATIVE_DELIVERY_RECORD_FAILED");
  });
});
