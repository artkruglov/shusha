/**
 * Telegram group registration tool tests.
 *
 * Constructs covered:
 * - `manage_telegram_group.register`: executes after private-owner HITL resume.
 * - A freshly authenticated group callback remains invalid for private-only administration.
 * - Owner-only dispatch can be assigned only to an external trust zone.
 * - Telegram must confirm the owner administers the chat before the chat is bound to the family;
 *   the checked Telegram user is the verified session actor, never a tool input.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { registerGroup, requireAdministrator } = vi.hoisted(() => ({
  registerGroup: vi.fn(),
  requireAdministrator: vi.fn(),
}));

vi.mock("./telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: { registerGroup, removeRegistration: vi.fn() },
}));
vi.mock("./telegram-group-admin-verification.js", () => ({
  telegramGroupAdminVerifier: { requireAdministrator },
}));

import { AppError } from "./app-error.js";
import manageTelegramGroup from "./tools/manage_telegram_group.js";

const OWNER_TELEGRAM_USER_ID = "101";
const abortController = new AbortController();

function context(
  chatType: "private" | "supergroup",
  actor: Record<string, unknown> = {
    telegramActorId: OWNER_TELEGRAM_USER_ID,
    telegramActorKind: "telegram_user",
    telegramUserId: OWNER_TELEGRAM_USER_ID,
  },
): ToolContext {
  const caller = {
    attributes: {
      familyId: "family-1",
      memoryScopes: ["personal", "family"],
      role: "owner",
      telegramChatId: chatType === "private" ? "101" : "-1001234567890",
      telegramChatType: chatType,
      ...actor,
    },
    authenticator: "telegram",
    principalId: "owner-1",
    principalType: "user" as const,
  };
  return {
    abortSignal: abortController.signal,
    session: {
      auth: {
        current: caller,
        initiator: caller,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
  } as unknown as ToolContext;
}

const input = {
  messageMode: "all" as const,
  telegramChatId: "-1001000000001",
  title: "Сицилия",
  type: "family_private" as const,
};

describe("manage_telegram_group.register", () => {
  beforeEach(() => {
    registerGroup.mockReset();
    registerGroup.mockResolvedValue({ groupId: "group-1" });
    requireAdministrator.mockReset();
    requireAdministrator.mockResolvedValue(undefined);
  });

  it("asks Telegram whether the verified owner administers the chat before persistence", async () => {
    const order: string[] = [];
    requireAdministrator.mockImplementation(async () => { order.push("telegram"); });
    registerGroup.mockImplementation(async () => {
      order.push("database");
      return { groupId: "group-1" };
    });

    await manageTelegramGroup.execute({ action: "register", registration: input }, context("private"));

    expect(requireAdministrator).toHaveBeenCalledWith({
      signal: abortController.signal,
      telegramChatId: "-1001000000001",
      telegramUserId: OWNER_TELEGRAM_USER_ID,
    });
    expect(order).toEqual(["telegram", "database"]);
  });

  it.each([
    "AGENT_TELEGRAM_GROUP_OWNER_NOT_ADMIN",
    "AGENT_TELEGRAM_GROUP_ADMIN_CHECK_REJECTED",
    "AGENT_TELEGRAM_GROUP_ADMIN_CHECK_UNAVAILABLE",
  ])("does not register the chat when Telegram verification fails with %s", async (code) => {
    requireAdministrator.mockRejectedValue(new AppError(code, "Группа не зарегистрирована"));

    await expect(manageTelegramGroup.execute(
      { action: "register", registration: input },
      context("private"),
    )).rejects.toMatchObject({ code });
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it.each([
    ["no Telegram user", {}],
    ["a bot actor", { telegramActorId: "777", telegramActorKind: "telegram_bot" }],
    ["a mismatched actor", {
      telegramActorId: "202",
      telegramActorKind: "telegram_user",
      telegramUserId: OWNER_TELEGRAM_USER_ID,
    }],
  ])("refuses registration when the session carries %s", async (_label, actor) => {
    await expect(manageTelegramGroup.execute(
      { action: "register", registration: input },
      context("private", actor),
    )).rejects.toMatchObject({ code: "AGENT_TELEGRAM_GROUP_OWNER_IDENTITY_MISSING" });
    expect(requireAdministrator).not.toHaveBeenCalled();
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it("does not consult Telegram while deciding whether registration needs approval", () => {
    const approval = manageTelegramGroup.approval as (context: never) => unknown;

    expect(approval({ toolInput: { action: "register", registration: input } } as never))
      .toBe("user-approval");
    expect(requireAdministrator).not.toHaveBeenCalled();
  });

  it("persists the group after a private owner approval resumes", async () => {
    await expect(manageTelegramGroup.execute(
      { action: "register", registration: input },
      context("private"),
    )).resolves.toEqual({
      active: true,
      groupId: "group-1",
      messageMode: "all",
      telegramChatId: "-1001000000001",
      title: "Сицилия",
      toolAllowlist: [],
      type: "family_private",
    });
    expect(registerGroup).toHaveBeenCalledWith({
      ...input,
      familyId: "family-1",
      requestedBy: "owner-1",
      toolAllowlist: [],
    });
  });

  it("ignores known top-level fields materialized beside registration", async () => {
    await expect(manageTelegramGroup.execute({
      action: "register",
      messageMode: "owner_only",
      registration: input,
      telegramChatId: "-1009999999999",
      toolAllowlist: ["remember"],
    }, context("private"))).resolves.toMatchObject({
      telegramChatId: "-1001000000001",
      type: "family_private",
    });
    expect(registerGroup).toHaveBeenCalledWith(expect.objectContaining({
      telegramChatId: "-1001000000001",
      type: "family_private",
    }));
  });

  it("rejects registration approval from a group chat", async () => {
    await expect(manageTelegramGroup.execute(
      { action: "register", registration: input },
      context("supergroup"),
    )).rejects.toThrowError(
      /AGENT_PRIVATE_CHAT_REQUIRED/,
    );
    expect(requireAdministrator).not.toHaveBeenCalled();
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it("rejects an external allowlist change from a group chat", async () => {
    await expect(manageTelegramGroup.execute(
      {
        action: "register",
        registration: {
          ...input,
          messageMode: "addressed_only",
          toolAllowlist: ["remember"],
          type: "external",
        },
      },
      context("supergroup"),
    )).rejects.toThrowError(/AGENT_PRIVATE_CHAT_REQUIRED/);
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it("persists owner-only dispatch for an external group", async () => {
    await manageTelegramGroup.execute({
      action: "register",
      registration: {
        ...input,
        messageMode: "owner_only",
        toolAllowlist: ["list_group_history"],
        type: "external",
      },
    }, context("private"));

    expect(registerGroup).toHaveBeenCalledWith(expect.objectContaining({
      messageMode: "owner_only",
      toolAllowlist: ["list_group_history"],
      type: "external",
    }));
  });

  it("rejects owner-only dispatch for a family group", async () => {
    await expect(manageTelegramGroup.execute({
      action: "register",
      registration: { ...input, messageMode: "owner_only" },
    }, context("private"))).rejects.toThrowError(/AGENT_TELEGRAM_GROUP_INPUT_INVALID/);

    expect(registerGroup).not.toHaveBeenCalled();
  });

  it.each([
    { ...input, telegramChatId: -1001000000001 },
    { ...input, title: "Рабочая группа\nTelegram chat ID: -100999" },
  ])("rejects ambiguous registration fields before persistence", async (registration) => {
    await expect(manageTelegramGroup.execute(
      { action: "register", registration } as never,
      context("private"),
    )).rejects.toThrowError(/AGENT_TELEGRAM_GROUP_INPUT_INVALID/);
    expect(registerGroup).not.toHaveBeenCalled();
  });
});
