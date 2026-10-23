/**
 * `/export` before Eve.
 *
 * Constructs covered:
 * - Memory and open tasks go as files to the person's own private chat under one ledger key per message.
 * - A redelivered, already sent export is silent; a refused delivery is recorded as failed and said.
 * - Groups, strangers and other text are left to the usual path.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./database-context.js", () => ({ withFamilyDatabaseContext: (_: string, work: () => unknown) => work() }));

import { AppError } from "./app-error.js";
import { handleExportCommand, type ExportCommandDependencies } from "./telegram-export-command.js";
import { groupMessage, privateMessage, telegramContext } from "./telegram-on-message.test-fixtures.js";

const IDENTITY = { familyId: "family-1", role: "member" as const, userId: "user-1" };
const AUTH = { familyId: "family-1", telegramUserId: "telegram-101", userId: "user-1" } as never;
const TASK = { dueAt: null, dueOn: "2026-10-20", id: "task-1", kind: "task", listName: "Дом", source: "Личное", status: "accepted", title: "Купить шины" };

function fakes(overrides: Partial<ExportCommandDependencies> = {}) {
  return {
    authorize: vi.fn(async () => AUTH),
    begin: vi.fn(async () => []),
    complete: vi.fn(async () => undefined),
    deliver: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    tasks: vi.fn(async () => ({ tasks: [TASK], waiting: [] })),
    ...overrides,
  };
}

describe("/export", () => {
  it("sends memory and open tasks to the person's own chat", async () => {
    const dependencies = fakes();
    const telegram = telegramContext();
    await expect(handleExportCommand({ ctx: telegram.context, identity: IDENTITY, message: privateMessage("/export") }, dependencies))
      .resolves.toBe(true);
    expect(dependencies.begin).toHaveBeenCalledWith(AUTH, "command-export:telegram-101:1");
    const files = vi.mocked(dependencies.deliver).mock.calls[0]![0] as { chatId: string; json: string; markdown: string };
    expect(files.chatId).toBe("telegram-101");
    expect(JSON.parse(files.json).tasks).toEqual([TASK]);
    expect(files.markdown).toContain("- Купить шины (Личное, Дом, срок 2026-10-20, accepted)");
    expect(dependencies.complete).toHaveBeenCalledWith(AUTH, "command-export:telegram-101:1");
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("stays silent on a redelivered export and records a refused one", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const telegram = telegramContext();
    const replay = fakes({ begin: vi.fn(async () => { throw new AppError("AGENT_MEMORY_EXPORT_ALREADY_DELIVERED", "Экспорт уже отправлен"); }) });
    await handleExportCommand({ ctx: telegram.context, identity: IDENTITY, message: privateMessage("/export") }, replay);
    expect(telegram.sendMessage).not.toHaveBeenCalled();

    const refused = fakes({ deliver: vi.fn(async () => {
      throw new AppError("AGENT_MEMORY_EXPORT_DELIVERY_FAILED", "Не удалось отправить файлы экспорта. Повторите запрос позже");
    }) });
    await handleExportCommand({ ctx: telegram.context, identity: IDENTITY, message: privateMessage("/export") }, refused);
    expect(refused.fail).toHaveBeenCalledWith(AUTH, "command-export:telegram-101:1", "AGENT_MEMORY_EXPORT_DELIVERY_FAILED");
    expect(refused.complete).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith("Не удалось отправить файлы экспорта. Повторите запрос позже");
    error.mockRestore();
  });

  it("leaves groups, strangers and other text alone", async () => {
    const dependencies = fakes();
    const telegram = telegramContext();
    expect(await handleExportCommand({ ctx: telegram.context, identity: IDENTITY, message: groupMessage("/export") }, dependencies)).toBe(false);
    expect(await handleExportCommand({ ctx: telegram.context, identity: null, message: privateMessage("/export") }, dependencies)).toBe(false);
    expect(await handleExportCommand({ ctx: telegram.context, identity: IDENTITY, message: privateMessage("/export всё") }, dependencies)).toBe(false);
    expect(dependencies.begin).not.toHaveBeenCalled();
  });
});
