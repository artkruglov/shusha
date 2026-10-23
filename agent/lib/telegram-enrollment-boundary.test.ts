/**
 * Telegram enrollment boundary tests.
 *
 * Constructs covered:
 * - `handleTelegramEnrollmentBoundary`: accepts exact bootstrap commands without model dispatch.
 * - Ordinary private text cannot consume a bootstrap attempt.
 * - Existing identities cannot turn invitation deep links into conversation content.
 */
import { describe, expect, it, vi } from "vitest";

import { handleTelegramEnrollmentBoundary } from "./telegram-enrollment-boundary.js";
import {
  privateMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";

describe("handleTelegramEnrollmentBoundary", () => {
  it("claims an owner only from the exact bootstrap command", async () => {
    const repository = repositories();
    const code = "a".repeat(43);
    repository.telegram.hasOwner.mockResolvedValue(false);
    repository.telegram.claimFirstOwner.mockResolvedValue("claimed");
    const { context, sendMessage } = telegramContext();

    const consumed = await handleTelegramEnrollmentBoundary({
      ctx: context,
      identity: null,
      invitationCode: null,
      message: privateMessage(`/start ${code}`),
      repositories: repository,
    });

    expect(consumed).toBe(true);
    expect(repository.telegram.claimFirstOwner).toHaveBeenCalledWith(code, {
      displayName: "Анна",
      telegramUserId: "telegram-101",
      username: "anna",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "Владелец создан. Семейный агент готов к настройке.",
    );
  });

  it("does not spend bootstrap attempts on ordinary private text", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(false);
    const { context, sendMessage } = telegramContext();

    const consumed = await handleTelegramEnrollmentBoundary({
      ctx: context,
      identity: null,
      invitationCode: null,
      message: privateMessage("привет"),
      repositories: repository,
    });

    expect(consumed).toBe(true);
    expect(repository.telegram.claimFirstOwner).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "AGENT_BOOTSTRAP_COMMAND_INVALID: Откройте одноразовую ссылку владельца, полученную на сервере.",
    );
  });

  it("starts one more family from an exact new-family code when an owner already exists", async () => {
    const repository = repositories();
    const code = "b".repeat(43);
    repository.telegram.hasOwner.mockResolvedValue(true);
    repository.telegram.claimNewFamily.mockResolvedValue("claimed");
    const { context, sendMessage } = telegramContext();

    const consumed = await handleTelegramEnrollmentBoundary({
      ctx: context, identity: null, invitationCode: null, message: privateMessage(`/start ${code}`), repositories: repository,
    });

    expect(consumed).toBe(true);
    expect(repository.telegram.claimNewFamily).toHaveBeenCalledWith(code, {
      displayName: "Анна", telegramUserId: "telegram-101", username: "anna",
    });
    expect(repository.telegram.claimFirstOwner).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining("семейный помощник"));
  });

  it("refuses a wrong new-family code and never spends an attempt on ordinary text", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(true);
    repository.telegram.claimNewFamily.mockResolvedValue("invalid");
    const { context, sendMessage } = telegramContext();

    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: null, invitationCode: null, message: privateMessage(`/start ${"c".repeat(43)}`), repositories: repository,
    });
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining("AGENT_BOOTSTRAP_CODE_INVALID"));

    repository.telegram.claimNewFamily.mockClear();
    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: null, invitationCode: null, message: privateMessage("привет"), repositories: repository,
    });
    expect(repository.telegram.claimNewFamily).not.toHaveBeenCalled();
  });

  it("greets a new family with the cards, a family-chat button with admin rights and first-step buttons", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(true);
    repository.signup.claimSelfServeFamily.mockResolvedValue("claimed");
    const { context, sendMessage } = telegramContext();
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "yuna_agent");
    vi.stubEnv("PUBLIC_BASE_URL", "https://family.example");

    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: null, invitationCode: null, message: privateMessage("/start"), repositories: repository,
    });

    const request = (context.telegram as unknown as { request: ReturnType<typeof vi.fn> }).request;
    expect(request).toHaveBeenCalledWith("sendMediaGroup", expect.objectContaining({
      media: expect.arrayContaining([{ media: "https://family.example/app/img/onboarding/card-1-voice.jpg", type: "photo" }]),
    }));
    const [cards, greeting, steps] = [request.mock.invocationCallOrder[0]!, ...sendMessage.mock.invocationCallOrder];
    expect(cards).toBeLessThan(greeting!);
    expect(sendMessage.mock.calls[0]![0]).toMatchObject({
      reply_markup: { inline_keyboard: [[{ url: "https://t.me/yuna_agent?startgroup=family&admin=change_info+delete_messages+invite_users+pin_messages" }]] },
    });
    expect(steps).toBeGreaterThan(greeting!);
    expect(sendMessage.mock.calls[1]![0]).toMatchObject({ reply_markup: { keyboard: expect.arrayContaining([[{ text: "Пригласи близкого в семью" }]]) } });
    vi.unstubAllEnvs();
  });

  it("creates a family from a plain Start or the link word when the operator opened the entrance", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(true);
    repository.signup.claimSelfServeFamily.mockResolvedValue("claimed");
    const { context, sendMessage } = telegramContext();

    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: null, invitationCode: null, message: privateMessage("/start beta"), repositories: repository,
    });

    expect(repository.signup.claimSelfServeFamily).toHaveBeenCalledWith("beta", {
      displayName: "Анна", telegramUserId: "telegram-101", username: "anna",
    });
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining("Я Шуша"));
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining("не сквозное шифрование"));

    // The welcome names the installation: after the move to Юна it never says Шуша.
    vi.stubEnv("TELEGRAM_AGENT_NAME", "Юна");
    sendMessage.mockClear();
    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: null, invitationCode: null, message: privateMessage("/start beta"), repositories: repository,
    });
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining("Я Юна, семейный помощник"));
    vi.unstubAllEnvs();

    repository.signup.claimSelfServeFamily.mockClear();
    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: null, invitationCode: null, message: privateMessage("/start"), repositories: repository,
    });
    expect(repository.signup.claimSelfServeFamily).toHaveBeenCalledWith(null, expect.anything());
  });

  it("answers a closed entrance with the closed-circle waiting list and a full one with a waiting message", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(true);
    const { context, sendMessage } = telegramContext();

    repository.signup.claimSelfServeFamily.mockResolvedValue("closed");
    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: null, invitationCode: null, message: privateMessage("/start beta"), repositories: repository,
    });
    expect(sendMessage).toHaveBeenLastCalledWith(expect.stringContaining("закрытом кругу"));
    expect(sendMessage).not.toHaveBeenCalledWith(expect.stringContaining("AGENT_"));

    repository.signup.claimSelfServeFamily.mockResolvedValue("full");
    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: null, invitationCode: null, message: privateMessage("/start beta"), repositories: repository,
    });
    expect(sendMessage).toHaveBeenLastCalledWith(expect.stringContaining("места закончились"));
  });

  it("puts a person from a guest answer on the waiting list instead of denying access", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(true);
    const { context, sendMessage } = telegramContext();

    for (const claim of ["closed", "invalid"] as const) {
      repository.signup.claimSelfServeFamily.mockResolvedValue(claim);
      await handleTelegramEnrollmentBoundary({
        ctx: context, identity: null, invitationCode: null, message: privateMessage("/start g"), repositories: repository,
      });
      expect(sendMessage).toHaveBeenLastCalledWith(expect.stringContaining("закрытом кругу"));
    }
    expect(repository.signup.joinWaitlist).toHaveBeenCalledTimes(2);
  });

  it("tells the operator about a new person on the closed list once, not on every message", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(true);
    repository.signup.claimSelfServeFamily.mockResolvedValue("closed");
    const { context } = telegramContext();
    const notify = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    process.env.TELEGRAM_BOT_TOKEN = "123:test";

    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: null, invitationCode: null, message: privateMessage("/start"), repositories: repository,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String((notify.mock.calls[0]![1] as RequestInit).body)).toContain("Новая заявка");

    repository.signup.joinWaitlist.mockResolvedValue(false);
    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: null, invitationCode: null, message: privateMessage("а когда?"), repositories: repository,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    notify.mockRestore();
  });

  it("welcomes a member who joined by an auto-approve link and tells the owner", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(true);
    repository.family.claimInvitation.mockResolvedValue({ joined: { familyId: "f1", ownerTelegramUserId: "9001" } });
    const { context, sendMessage } = telegramContext();
    const notify = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    process.env.TELEGRAM_BOT_TOKEN = "123:test";

    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: null, invitationCode: "a".repeat(32), message: privateMessage(`/start ${"a".repeat(32)}`), repositories: repository,
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining("Вы в семье"));
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: "С чего начнём?" }));
    expect(notify).toHaveBeenCalled();
    notify.mockRestore();
  });

  it("never turns a rejected invitation link or ordinary text into a family", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(true);
    repository.family.claimInvitation.mockResolvedValue("invalid");
    const { context } = telegramContext();

    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: null, invitationCode: "a".repeat(32), message: privateMessage(`/start ${"a".repeat(32)}`), repositories: repository,
    });
    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: null, invitationCode: null, message: privateMessage("привет"), repositories: repository,
    });

    expect(repository.signup.claimSelfServeFamily).not.toHaveBeenCalled();
  });

  it("lets only the operator manage the entrance with /signup", async () => {
    const repository = repositories();
    const { context, sendMessage } = telegramContext();
    repository.signup.status.mockResolvedValue({ families: 1, isOpen: false, maxFamilies: 0, word: null });
    repository.signup.update.mockResolvedValue({ families: 1, isOpen: true, maxFamilies: 5, word: "beta" });

    repository.signup.isOperatorFamily.mockResolvedValue(false);
    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: { familyId: "f2", role: "owner", userId: "u2" }, invitationCode: null,
      message: privateMessage("/signup open 5 beta"), repositories: repository,
    });
    expect(sendMessage).toHaveBeenLastCalledWith(expect.stringContaining("AGENT_SIGNUP_FORBIDDEN"));
    expect(repository.signup.update).not.toHaveBeenCalled();

    repository.signup.isOperatorFamily.mockResolvedValue(true);
    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: { familyId: "f1", role: "owner", userId: "u1" }, invitationCode: null,
      message: privateMessage("/signup open 5 beta"), repositories: repository,
    });
    expect(repository.signup.update).toHaveBeenCalledWith({ isOpen: true, maxFamilies: 5, word: "beta" });
    expect(sendMessage).toHaveBeenLastCalledWith("Вход открыт: семей 1 из 5, слово: beta.");

    await handleTelegramEnrollmentBoundary({
      ctx: context, identity: { familyId: "f1", role: "owner", userId: "u1" }, invitationCode: null,
      message: privateMessage("/signup"), repositories: repository,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("Вход закрыт. Семей: 1.");
  });

  it("consumes an existing member invitation without claiming it", async () => {
    const repository = repositories();
    const { context, sendMessage } = telegramContext();

    const consumed = await handleTelegramEnrollmentBoundary({
      ctx: context,
      identity: { familyId: "family-1", role: "member", userId: "user-1" },
      invitationCode: "a".repeat(32),
      message: privateMessage(`/start ${"a".repeat(32)}`),
      repositories: repository,
    });

    expect(consumed).toBe(true);
    expect(repository.family.claimInvitation).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "AGENT_INVITATION_NOT_APPLICABLE: Вы уже подключены к семейному агенту.",
    );
  });
});
