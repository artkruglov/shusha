/**
 * `/export` on the real schema: the person's own memory ledger and board, nothing of another member.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { createTaskFamilyFixture, makeTask } from "./shared-task.integration-fixtures.js";
import { exportCommandDependencies, handleExportCommand } from "./telegram-export-command.js";
import { privateMessage, telegramContext } from "./telegram-on-message.test-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

(enabled ? describe : describe.skip)("/export on the real schema", () => {
  let owner: MemoryAuthorization;
  let member: MemoryAuthorization;

  beforeEach(async () => {
    ({ owner, member } = await createTaskFamilyFixture());
  });
  afterAll(closeDatabase);

  it("exports the person's own tasks once per message, and not another member's", async () => {
    await makeTask(owner, "Купить шины");
    await makeTask(member, "Записаться к педиатру");
    const deliver = vi.fn(async () => undefined);
    const message = { ...privateMessage("/export"), chat: { id: "700101", type: "private" as const },
      from: { firstName: "Owner", id: "700101", isBot: false } };
    const identity = { familyId: owner.familyId, role: "owner" as const, userId: owner.userId! };
    const telegram = telegramContext();
    await handleExportCommand({ ctx: telegram.context, identity, message }, { ...exportCommandDependencies, deliver });

    expect(deliver).toHaveBeenCalledTimes(1);
    const json = JSON.parse((deliver.mock.calls[0] as unknown as [{ json: string }])[0].json) as { tasks: Array<{ title: string }> };
    expect(json.tasks.map((task) => task.title)).toEqual(["Купить шины"]);
    const ledger = await database().query<{ status: string }>("SELECT status FROM memory_exports WHERE operation_key = $1",
      ["command-export:700101:1"]);
    expect(ledger.rows[0]!.status).toBe("completed");

    // The same update again: the ledger knows it, nothing is sent and nothing is said.
    await handleExportCommand({ ctx: telegram.context, identity, message }, { ...exportCommandDependencies, deliver });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
});
