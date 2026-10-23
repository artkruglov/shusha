/**
 * `/delete_me` and `/delete_family` before Eve.
 *
 * Constructs covered:
 * - The bare command explains what goes and how to confirm; nothing is erased.
 * - The confirmed command erases; the owner cannot leave, a member cannot delete the family.
 * - A refusal from the repository is told in Russian; groups and strangers are left alone.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "./app-error.js";
import { handleDeletionCommand, type DeletionCommandDependencies } from "./telegram-deletion-command.js";
import { groupMessage, privateMessage, telegramContext } from "./telegram-on-message.test-fixtures.js";

const MEMBER = { familyId: "family-1", role: "member" as const, userId: "user-2" };
const OWNER = { familyId: "family-1", role: "owner" as const, userId: "user-1" };

function fakes(overrides: Partial<DeletionCommandDependencies> = {}) {
  return {
    deleteFamily: vi.fn(async () => ({ members: 3 })),
    deleteMember: vi.fn(async () => undefined),
    family: vi.fn(async () => ({ members: 3, name: "Ивановы" })),
    ...overrides,
  };
}

const run = (identity: typeof MEMBER | typeof OWNER | null, text: string, dependencies: DeletionCommandDependencies, group = false) => {
  const telegram = telegramContext();
  const done = handleDeletionCommand({ ctx: telegram.context, identity, message: group ? groupMessage(text) : privateMessage(text) }, dependencies);
  return { done, telegram };
};

describe("deletion commands", () => {
  it("explains first and erases only after «подтверждаю»", async () => {
    const dependencies = fakes();
    const first = run(MEMBER, "/delete_me", dependencies);
    await expect(first.done).resolves.toBe(true);
    expect(first.telegram.sendMessage.mock.calls[0]![0]).toContain("Чтобы подтвердить, отправьте: /delete_me подтверждаю");
    expect(first.telegram.sendMessage.mock.calls[0]![0]).toContain("«Ивановы»");
    expect(dependencies.deleteMember).not.toHaveBeenCalled();

    const confirmed = run(MEMBER, "/delete_me Подтверждаю", dependencies);
    await confirmed.done;
    expect(dependencies.deleteMember).toHaveBeenCalledWith({ familyId: "family-1", userId: "user-2" });
    expect(confirmed.telegram.sendMessage.mock.calls[0]![0]).toContain("Готово");

    const family = run(OWNER, "/delete_family подтверждаю", dependencies);
    await family.done;
    expect(dependencies.deleteFamily).toHaveBeenCalledWith({ familyId: "family-1", ownerUserId: "user-1" });
  });

  it("keeps the owner from leaving and a member from deleting the family", async () => {
    const dependencies = fakes();
    const owner = run(OWNER, "/delete_me подтверждаю", dependencies);
    await owner.done;
    expect(owner.telegram.sendMessage.mock.calls[0]![0]).toContain("/delete_family");
    const member = run(MEMBER, "/delete_family подтверждаю", dependencies);
    await member.done;
    expect(member.telegram.sendMessage.mock.calls[0]![0]).toContain("только её владелец");
    expect(dependencies.deleteMember).not.toHaveBeenCalled();
    expect(dependencies.deleteFamily).not.toHaveBeenCalled();
  });

  it("tells a refusal and leaves groups and strangers alone", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = fakes({ deleteMember: vi.fn(async () => { throw new AppError("AGENT_ACCESS_DENIED", "Вы уже не в семье"); }) });
    const attempt = run(MEMBER, "/delete_me подтверждаю", refused);
    await attempt.done;
    expect(attempt.telegram.sendMessage).toHaveBeenCalledWith("Вы уже не в семье");
    error.mockRestore();

    const dependencies = fakes();
    await expect(run(MEMBER, "/delete_me", dependencies, true).done).resolves.toBe(false);
    await expect(run(null, "/delete_me", dependencies).done).resolves.toBe(false);
    await expect(run(MEMBER, "удали меня", dependencies).done).resolves.toBe(false);
  });
});
