/**
 * Telegram proof that the owner administers a group before it is bound to a family.
 *
 * Constructs covered:
 * - `createTelegramGroupAdminVerifier`: one bounded `getChatMember` call for the exact owner.
 * - Only `creator` and `administrator` pass; every other status refuses with a stable code.
 * - Telegram rejections, transport failures and malformed answers fail closed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelegramGroupAdminVerifier } from "./telegram-group-admin-verification.js";

const CHAT_ID = "-1001234567890";
const OWNER_TELEGRAM_USER_ID = "424242";

function telegramAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function memberAnswer(status: string, userId: number = Number(OWNER_TELEGRAM_USER_ID)): Response {
  return telegramAnswer({ ok: true, result: { status, user: { id: userId, is_bot: false } } });
}

function verifier(fetchImplementation: typeof fetch) {
  return createTelegramGroupAdminVerifier({
    botToken: "telegram-bot-secret",
    fetch: fetchImplementation,
    timeoutMilliseconds: 15_000,
  });
}

function check(fetchImplementation: typeof fetch, signal?: AbortSignal) {
  return verifier(fetchImplementation).requireAdministrator({
    ...(signal === undefined ? {} : { signal }),
    telegramChatId: CHAT_ID,
    telegramUserId: OWNER_TELEGRAM_USER_ID,
  });
}

describe("telegram group admin verification", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["creator", "administrator"])("accepts an owner whose chat status is %s", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(memberAnswer(status));

    await expect(check(fetchMock)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-bot-secret/getChatMember",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      chat_id: CHAT_ID,
      user_id: Number(OWNER_TELEGRAM_USER_ID),
    });
  });

  it.each(["member", "restricted", "left", "kicked", "owner"])(
    "refuses an owner whose chat status is %s",
    async (status) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(check(vi.fn().mockResolvedValue(memberAnswer(status)))).rejects.toMatchObject({
        code: "AGENT_TELEGRAM_GROUP_OWNER_NOT_ADMIN",
        message: expect.stringMatching(/администратор/u),
      });
    },
  );

  it.each([
    [400, "Bad Request: chat not found"],
    [403, "Forbidden: bot is not a member of the supergroup chat"],
    [403, "Forbidden: bot was kicked from the supergroup chat"],
  ])("fails closed when Telegram rejects the lookup with %s", async (status, description) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(
      telegramAnswer({ description, error_code: status, ok: false }, status),
    );

    await expect(check(fetchMock)).rejects.toMatchObject({
      code: "AGENT_TELEGRAM_GROUP_ADMIN_CHECK_REJECTED",
      message: expect.stringMatching(/бот/u),
    });
    const logged = JSON.parse(String(errors.mock.calls[0]![0])) as Record<string, unknown>;
    expect(logged).toMatchObject({
      code: "AGENT_TELEGRAM_GROUP_ADMIN_CHECK_REJECTED",
      providerDescription: description,
      providerStatus: status,
    });
    expect(JSON.stringify(logged)).not.toContain("telegram-bot-secret");
  });

  it.each([500, 502, 429])("fails closed when Telegram is unavailable with %s", async (status) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(
      telegramAnswer({ description: "Internal Server Error", error_code: status, ok: false }, status),
    );

    await expect(check(fetchMock)).rejects.toMatchObject({
      code: "AGENT_TELEGRAM_GROUP_ADMIN_CHECK_UNAVAILABLE",
    });
  });

  it("fails closed on a network failure or timeout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
    );

    await expect(check(fetchMock)).rejects.toMatchObject({
      code: "AGENT_TELEGRAM_GROUP_ADMIN_CHECK_UNAVAILABLE",
    });
  });

  it("joins the caller's cancellation with the request deadline", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(memberAnswer("administrator"));

    await check(fetchMock, controller.signal);

    const signal = (fetchMock.mock.calls[0]![1] as RequestInit).signal!;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it.each([
    ["no result", { ok: true }],
    ["no status", { ok: true, result: { user: { id: Number(OWNER_TELEGRAM_USER_ID) } } }],
    ["another user", { ok: true, result: { status: "creator", user: { id: 1 } } }],
    ["not ok", { ok: false, result: { status: "creator", user: { id: Number(OWNER_TELEGRAM_USER_ID) } } }],
  ])("fails closed on a malformed answer: %s", async (_label, body) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(check(vi.fn().mockResolvedValue(telegramAnswer(body)))).rejects.toMatchObject({
      code: "AGENT_TELEGRAM_GROUP_ADMIN_CHECK_RESPONSE_INVALID",
    });
  });

  it.each(["", "abc", "-5", "0", "1.5", "99999999999999999999"])(
    "refuses an unusable owner Telegram identity %j without calling Telegram",
    async (telegramUserId) => {
      const fetchMock = vi.fn();

      await expect(verifier(fetchMock).requireAdministrator({
        telegramChatId: CHAT_ID,
        telegramUserId,
      })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_GROUP_OWNER_IDENTITY_MISSING" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("requires a configured bot token", () => {
    expect(() => createTelegramGroupAdminVerifier({
      botToken: "",
      fetch: vi.fn(),
      timeoutMilliseconds: 15_000,
    })).toThrowError(/AGENT_TELEGRAM_CONFIG_MISSING/u);
  });
});
