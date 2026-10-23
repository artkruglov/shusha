/**
 * Заявки в обычную группу семьи: приветствие в личке, участник семьи входит сам, остальных решает владелец.
 *
 * Constructs covered:
 * - Приветствие только по ссылке самого бота, не ботам и не в чужие группы.
 * - «Вступить» участника семьи одобряет заявку; не участника превращается в вопрос владельцу.
 * - «Не сейчас» отклоняет заявку.
 * - Решает только владелец семьи по базе; пересланная кнопка чужая. Нажатие не из своей лички не действует.
 * - Заявки уже нет: понятный итог вместо ошибки; сбой Telegram отвечает и не валит update.
 * - Без приветствия (подделанная кнопка), со второго нажатия и после решения ничего не происходит: владелец
 *   получает вопрос один раз. Не дошедшее приветствие не валит update и не оставляет строки.
 * - Разбор данных кнопок: лишние и кривые части отвергаются.
 */
import type { TelegramCallbackQuery } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import type { JoinGroup } from "./group-join-repository.js";
import { createGroupJoin, GROUP_JOIN_TEXT, parseGroupJoinCallback } from "./group-join.js";
import type { GroupJoinTransport } from "./group-join-transport.js";

const GROUP: JoinGroup = {
  familyId: "11111111-1111-4111-8111-111111111111", groupId: "22222222-2222-4222-8222-222222222222",
  ownerName: "Артём", ownerTelegramUserId: "500", telegramChatId: "-1009", title: "Квартира",
};

function setup(options: { member?: boolean; group?: JoinGroup | null; rows?: Record<string, "greeted" | "asked"> } = {}) {
  // Строки приглашений по человеку; по умолчанию бот уже встретил 600 и 601, а вопрос про 601 у владельца.
  const rows = new Map(Object.entries(options.rows ?? { 600: "greeted", 601: "greeted" }));
  const invitations = {
    forget: vi.fn(async (_group: string, user: string) => { rows.delete(user); }),
    greet: vi.fn(async (_group: JoinGroup, user: string) => { rows.set(user, "greeted"); }),
    release: vi.fn(async (_group: string, user: string) => { if (rows.get(user) === "asked") rows.set(user, "greeted"); }),
    take: vi.fn(async (_group: string, user: string, from: "greeted" | "asked", to: "asked" | null) => {
      if (rows.get(user) !== from) return false;
      if (to === null) rows.delete(user); else rows.set(user, to);
      return true;
    }),
  };
  const transport = {
    approve: vi.fn(async () => true),
    botRights: vi.fn(async () => ({ invite: true, pin: true })),
    createInviteLink: vi.fn(async () => "https://t.me/+x"),
    decline: vi.fn(async () => true),
    edit: vi.fn(async () => undefined),
    pin: vi.fn(async () => undefined),
    send: vi.fn(async () => "77"),
  } satisfies GroupJoinTransport;
  const answer = vi.fn(async () => undefined);
  const join = createGroupJoin({
    agentName: () => "Шуша",
    answer,
    botId: () => "42",
    findGroup: vi.fn(async (chatId: string) => (chatId === GROUP.telegramChatId ? options.group === undefined ? GROUP : options.group : null)),
    invitations,
    isFamilyMember: vi.fn(async () => options.member ?? false),
    transport,
  });
  return { answer, invitations, join, rows, transport };
}

function joinRequest(overrides: Record<string, unknown> = {}) {
  return {
    chat_join_request: {
      chat: { id: -1009, title: "Квартира", type: "supergroup" },
      date: 1, from: { first_name: "Ирина", id: 600, is_bot: false },
      invite_link: { creator: { id: 42, is_bot: true }, creates_join_request: true, invite_link: "https://t.me/+x" },
      user_chat_id: 600, ...overrides,
    },
    update_id: 1,
  };
}

function press(data: string, from: { id: string; firstName?: string; username?: string }, chatId = from.id, text?: string): TelegramCallbackQuery {
  return {
    data, from: { isBot: false, ...from }, id: "cb1",
    message: { chat: { id: chatId, type: "private" } as never, messageId: "9" },
    raw: { message: { text } },
  };
}

describe("group join requests", () => {
  it("greets a person who asks by the bot's own link, with the owner and the group named", async () => {
    const { join, rows, transport } = setup({ rows: {} });
    await join.request(joinRequest());
    expect(rows.get("600")).toBe("greeted");
    expect(transport.send).toHaveBeenCalledWith("600", GROUP_JOIN_TEXT.invite("Артём", "Квартира", "Шуша"), [[
      { callback_data: "gj:j:-1009", text: "Вступить" }, { callback_data: "gj:n:-1009", text: "Не сейчас" },
    ]]);
  });

  it("leaves alone a request by someone else's link, a bot, and a chat that is not an ordinary family group", async () => {
    const { join, transport } = setup();
    await join.request(joinRequest({ invite_link: { creator: { id: 500 } } }));
    await join.request(joinRequest({ invite_link: undefined }));
    await join.request(joinRequest({ from: { first_name: "Бот", id: 601, is_bot: true } }));
    await join.request(joinRequest({ chat: { id: -1010, type: "supergroup" } }));
    await join.request({ chat_join_request: { chat: "broken" }, update_id: 2 });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("lets a family member in at once", async () => {
    const { answer, join, transport } = setup({ member: true });
    expect(await join.callback(press("gj:j:-1009", { id: "600" }))).toBe(true);
    expect(transport.approve).toHaveBeenCalledWith("-1009", "600");
    expect(transport.edit).toHaveBeenCalledWith("600", "9", GROUP_JOIN_TEXT.approved("Квартира"), undefined);
    expect(transport.send).not.toHaveBeenCalled();
    expect(answer).toHaveBeenCalledWith("cb1", undefined);
  });

  it("asks the owner about anyone outside the family and lets in only on the owner's press", async () => {
    const { join, transport } = setup();
    await join.callback(press("gj:j:-1009", { firstName: "Оля", id: "601", username: "olya" }));
    expect(transport.approve).not.toHaveBeenCalled();
    const ask = GROUP_JOIN_TEXT.ownerAsk("Оля (@olya)", "Квартира");
    expect(transport.send).toHaveBeenCalledWith("500", ask, [[
      { callback_data: "gj:a:-1009:601", text: "Пустить" }, { callback_data: "gj:r:-1009:601", text: "Отклонить" },
    ]]);
    expect(transport.edit).toHaveBeenCalledWith("601", "9", GROUP_JOIN_TEXT.asked("Артём"), undefined);

    // Forwarded to someone else, the owner's button does nothing.
    const { answer: strangerAnswer, join: again, transport: other } = setup();
    await again.callback(press("gj:a:-1009:601", { id: "601" }));
    expect(other.approve).not.toHaveBeenCalled();
    expect(strangerAnswer).toHaveBeenCalledWith("cb1", GROUP_JOIN_TEXT.notOwner);

    // A second tap of «Вступить» does not ask the owner again.
    await join.callback(press("gj:j:-1009", { firstName: "Оля", id: "601", username: "olya" }));
    expect(transport.send).toHaveBeenCalledOnce();

    await join.callback(press("gj:a:-1009:601", { id: "500" }, "500", ask));
    expect(transport.approve).toHaveBeenCalledWith("-1009", "601");
    expect(transport.edit).toHaveBeenLastCalledWith("500", "9", `${ask}\n\n${GROUP_JOIN_TEXT.ownerApproved}`, undefined);
    // Pressed again, or redelivered after a crash: decided once.
    await join.callback(press("gj:a:-1009:601", { id: "500" }, "500", ask));
    expect(transport.approve).toHaveBeenCalledOnce();
  });

  it("declines on «Не сейчас» and on the owner's «Отклонить»", async () => {
    const { join, transport } = setup({ rows: { 600: "greeted", 601: "asked" } });
    await join.callback(press("gj:n:-1009", { id: "600" }));
    expect(transport.decline).toHaveBeenCalledWith("-1009", "600");
    expect(transport.edit).toHaveBeenCalledWith("600", "9", GROUP_JOIN_TEXT.notNow, undefined);
    await join.callback(press("gj:r:-1009:601", { id: "500" }, "500"));
    expect(transport.decline).toHaveBeenCalledWith("-1009", "601");
    expect(transport.edit).toHaveBeenLastCalledWith("500", "9", GROUP_JOIN_TEXT.ownerRejected, undefined);
  });

  it("ignores a press from any chat but the presser's own private chat", async () => {
    const { answer, join, transport } = setup({ member: true });
    expect(await join.callback(press("gj:j:-1009", { id: "600" }, "-1009"))).toBe(true);
    expect(transport.approve).not.toHaveBeenCalled();
    expect(answer).toHaveBeenCalledOnce();
  });

  it("says the request is gone, the group is gone, or the press failed, and never throws", async () => {
    const gone = setup({ rows: { 601: "asked" } });
    gone.transport.approve.mockResolvedValue(false);
    await gone.join.callback(press("gj:a:-1009:601", { id: "500" }, "500"));
    expect(gone.transport.edit).toHaveBeenCalledWith("500", "9", GROUP_JOIN_TEXT.gone, undefined);

    const disconnected = setup({ group: null });
    await disconnected.join.callback(press("gj:j:-1009", { id: "600" }));
    expect(disconnected.transport.edit).toHaveBeenCalledWith("600", "9", GROUP_JOIN_TEXT.unavailable, undefined);

    const broken = setup({ member: true });
    broken.transport.approve.mockRejectedValue(new Error("network"));
    expect(await broken.join.callback(press("gj:j:-1009", { id: "600" }))).toBe(true);
    expect(broken.answer).toHaveBeenCalledWith("cb1", GROUP_JOIN_TEXT.failed);
  });

  it("does nothing for a press without a greeting: a forged button or a request by someone else's link", async () => {
    const { join, transport } = setup({ member: true, rows: {} });
    await join.callback(press("gj:j:-1009", { id: "600" }));
    await join.callback(press("gj:j:-1009", { id: "601" }));
    await join.callback(press("gj:a:-1009:601", { id: "500" }, "500"));
    expect(transport.approve).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
    expect(transport.edit).toHaveBeenCalledWith("600", "9", GROUP_JOIN_TEXT.goneSelf, undefined);
  });

  it("lets the person try again when the owner question did not go out", async () => {
    const { join, rows, transport } = setup();
    transport.send.mockRejectedValueOnce(new Error("Forbidden: bot was blocked by the user"));
    await join.callback(press("gj:j:-1009", { id: "601" }));
    expect(rows.get("601")).toBe("greeted");
    await join.callback(press("gj:j:-1009", { id: "601" }));
    expect(rows.get("601")).toBe("asked");
  });

  it("completes a join request whose greeting cannot be delivered and leaves no row", async () => {
    const { join, rows, transport } = setup({ rows: {} });
    transport.send.mockRejectedValue(new Error("Forbidden: bot can't initiate conversation with a user"));
    await expect(join.request(joinRequest())).resolves.toBeUndefined();
    expect(rows.size).toBe(0);
  });

  it("parses only well-formed button data and leaves other buttons to their handlers", async () => {
    expect(parseGroupJoinCallback("gj:j:-1009")).toEqual({ by: "requester", chatId: "-1009", choice: "join" });
    expect(parseGroupJoinCallback("gj:a:-1009:601")).toEqual({ by: "owner", chatId: "-1009", choice: "approve", userId: "601" });
    for (const bad of ["gj:j:1009", "gj:j:-1009:601", "gj:a:-1009", "gj:a:-1009:x", "gj:x:-1009", "gj:a:-1009:601:1"]) {
      expect(parseGroupJoinCallback(bad)).toBeNull();
    }
    const { answer, join } = setup();
    expect(await join.callback(press("tb:1", { id: "600" }))).toBe(false);
    expect(await join.callback(press("gj:junk", { id: "600" }))).toBe(true);
    expect(answer).toHaveBeenCalledOnce();
  });
});
