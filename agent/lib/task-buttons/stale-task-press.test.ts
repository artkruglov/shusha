import { describe, expect, it, vi } from "vitest";

import { answerStaleTask, localClock, zonedInstant } from "./stale-task-press.js";

const AUTH = { familyId: "f", userId: "u" } as never;

describe("«Через неделю» under the message about a task that has not moved", () => {
  it("keeps the local hour across a DST change and does not depend on the old date", async () => {
    // Europe/Berlin leaves summer time on 25 October 2026.
    const change = vi.fn().mockImplementation(async (_auth, input) => ({ dueAt: input.dueAt, dueOn: null, title: "Созвон", version: 4 }));
    const read = vi.fn().mockResolvedValue({ dueAt: "2026-09-01T07:30:00Z", dueOn: null, title: "Созвон", version: 3 });
    const line = await answerStaleTask({ change, read, rest: vi.fn(), timezone: async () => "Europe/Berlin" }, {
      action: "postpone_week", auth: AUTH, id: "t", now: new Date("2026-10-21T09:00:00Z"), operationKey: "k", version: 3,
    });

    const sent = change.mock.calls[0]![1] as { dueAt: string };
    expect(localClock(sent.dueAt, "Europe/Berlin")).toBe("09:30");
    expect(sent.dueAt).toBe("2026-10-28T08:30:00.000Z");
    expect(line).toMatch(/^Перенесено на .+: Созвон$/u);
  });

  it("finds the instant of a wall clock in a zone", () => {
    expect(zonedInstant("2026-10-28", "09:30", "Europe/Moscow").toISOString()).toBe("2026-10-28T06:30:00.000Z");
    expect(zonedInstant("2026-07-01", "09:30", "Europe/Berlin").toISOString()).toBe("2026-07-01T07:30:00.000Z");
  });
});
