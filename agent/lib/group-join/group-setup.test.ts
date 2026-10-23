/**
 * Подготовка подключённой группы: приветствие, закреп и ссылка владельцу.
 *
 * Constructs covered:
 * - С правами администратора приветствие закрепляется, а владелец получает ссылку с заявками.
 * - Без прав приветствие просит их, ничего не закрепляется и ссылки нет; сбой проверки прав считается «без прав».
 * - Сбой закрепа или ссылки не отменяет подготовку; сбой приветствия возвращает false.
 * - `inviteLink` выпускает ссылку только при праве приглашать.
 */
import { describe, expect, it, vi } from "vitest";

import type { GroupJoinTransport } from "./group-join-transport.js";
import { createGroupSetup, GROUP_SETUP_TEXT } from "./group-setup.js";

function setup(rights = { invite: true, pin: true }) {
  const transport = {
    approve: vi.fn(async () => true),
    botRights: vi.fn(async () => rights),
    createInviteLink: vi.fn(async () => "https://t.me/+abc"),
    decline: vi.fn(async () => true),
    edit: vi.fn(async () => undefined),
    pin: vi.fn(async () => undefined),
    send: vi.fn(async () => "31"),
  } satisfies GroupJoinTransport;
  return { setup: createGroupSetup({ agentName: () => "Шуша", transport }), transport };
}

const INPUT = { ownerTelegramUserId: "500", telegramChatId: "-1009", title: "Квартира" };

describe("group setup", () => {
  it("pins the welcome and sends the owner a join-request link when the bot is an administrator", async () => {
    const { setup: groups, transport } = setup();
    expect(await groups.prepare(INPUT)).toBe(true);
    expect(transport.send).toHaveBeenNthCalledWith(1, "-1009", GROUP_SETUP_TEXT.welcome("Шуша"));
    expect(transport.pin).toHaveBeenCalledWith("-1009", "31");
    expect(transport.createInviteLink).toHaveBeenCalledWith("-1009", "Шуша");
    expect(transport.send).toHaveBeenNthCalledWith(2, "500", GROUP_SETUP_TEXT.ownerLink("Квартира", "https://t.me/+abc"));
  });

  it("asks for the rights and does nothing else without them", async () => {
    for (const make of [() => setup({ invite: false, pin: false }), () => {
      const failing = setup();
      failing.transport.botRights.mockRejectedValue(new Error("network"));
      return failing;
    }]) {
      const { setup: groups, transport } = make();
      expect(await groups.prepare(INPUT)).toBe(true);
      expect(transport.send).toHaveBeenCalledOnce();
      expect(transport.send).toHaveBeenCalledWith("-1009", GROUP_SETUP_TEXT.welcome("Шуша") + GROUP_SETUP_TEXT.needsRights);
      expect(transport.pin).not.toHaveBeenCalled();
      expect(transport.createInviteLink).not.toHaveBeenCalled();
    }
  });

  it("survives a failed pin or link and reports a failed welcome", async () => {
    const partial = setup();
    partial.transport.pin.mockRejectedValue(new Error("no"));
    partial.transport.createInviteLink.mockRejectedValue(new Error("no"));
    expect(await partial.setup.prepare(INPUT)).toBe(true);

    const silent = setup();
    silent.transport.send.mockRejectedValue(new Error("kicked"));
    expect(await silent.setup.prepare(INPUT)).toBe(false);
    expect(silent.transport.pin).not.toHaveBeenCalled();
  });

  it("issues an invite link only with the right to invite", async () => {
    expect(await setup().setup.inviteLink("-1009")).toBe("https://t.me/+abc");
    const without = setup({ invite: false, pin: true });
    expect(await without.setup.inviteLink("-1009")).toBeNull();
    expect(without.transport.createInviteLink).not.toHaveBeenCalled();
  });
});
