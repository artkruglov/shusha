/**
 * `/start@бот group` («Группы», MVP-1) в разборе входящего сообщения, без модели.
 *
 * Constructs covered:
 * - Без флага команда идёт прежним путём группы без семьи, команда подключения не вызывается.
 * - С флагом команда владельца уходит в подключение, чат получает ответ, ход модели не начинается.
 * - Подключённая группа готовится (приветствие, ссылка владельцу); ответ команды остаётся, только если подготовка
 *   не отправила даже приветствия.
 * - Команда другому боту, голосовое с такой расшифровкой и `/start group` с лишними словами не подключают.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { groupsEnabled, groupCreateLink } from "./groups-availability.js";
import { GROUP_CONNECT_REPLIES, parseGroupConnectCommand } from "./telegram-group-connect-command.js";
import { BOT_USERNAME, groupMessage, repositories, telegramContext } from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";

describe("«Группы» flag and link", () => {
  it("is on only for the exact value true", () => {
    expect(groupsEnabled({ WEB_APP_GROUPS_ENABLED: "true" })).toBe(true);
    for (const value of [undefined, "", "1", "TRUE", "true ", "yes"]) {
      expect(groupsEnabled({ WEB_APP_GROUPS_ENABLED: value })).toBe(false);
    }
  });

  it("builds the owner's link only for a valid bot username", () => {
    expect(groupCreateLink("osinara_bot"))
      .toBe("https://t.me/osinara_bot?startgroup=group&admin=change_info+delete_messages+invite_users+pin_messages");
    for (const name of [undefined, "", "bot", "bad name", "x/../y", "a".repeat(33)]) expect(groupCreateLink(name)).toBeNull();
  });

  it("parses only the bare command or the one addressed to this bot", () => {
    expect(parseGroupConnectCommand("/start group", BOT_USERNAME)).toBe(true);
    expect(parseGroupConnectCommand(`/start@${BOT_USERNAME} group`, BOT_USERNAME)).toBe(true);
    expect(parseGroupConnectCommand(`/start@${BOT_USERNAME.toUpperCase()} group`, BOT_USERNAME)).toBe(true);
    for (const text of ["/start@other_bot group", "/start group now", "/start groups", "/start family", "/start", "group"]) {
      expect(parseGroupConnectCommand(text, BOT_USERNAME)).toBe(false);
    }
  });
});

describe("createTelegramMessageHandler /start group", () => {
  const command = `/start@${BOT_USERNAME} group`;

  it("keeps today's path without the flag: the group-without-a-family command takes it", async () => {
    const repository = repositories();
    const { context } = telegramContext();
    await expect(createTelegramMessageHandler(repository)(context, groupMessage(command))).resolves.toBeNull();
    expect(repository.groupConnect.command).not.toHaveBeenCalled();
    expect(repository.familylessGroup.command).toHaveBeenCalledWith(expect.objectContaining({ command: "start" }));
  });

  it("connects the group with the flag on and answers in the chat without a model turn", async () => {
    const repository = repositories();
    repository.groupConnect.enabled = true;
    const { context, sendMessage } = telegramContext();
    await expect(createTelegramMessageHandler(repository)(context, groupMessage(command))).resolves.toBeNull();
    expect(repository.groupConnect.command).toHaveBeenCalledWith({
      telegramChatId: "group-101", telegramUserId: "telegram-101", title: "Группа",
    });
    expect(sendMessage).toHaveBeenCalledWith(GROUP_CONNECT_REPLIES.registered);
    expect(repository.familylessGroup.command).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it("prepares a just connected group instead of the plain reply, and falls back when even the welcome failed", async () => {
    const repository = repositories();
    repository.groupConnect.enabled = true;
    const prepare = vi.fn(async () => true);
    repository.groupConnect.prepare = prepare;
    const { context, sendMessage } = telegramContext();
    await createTelegramMessageHandler(repository)(context, groupMessage(command));
    expect(prepare).toHaveBeenCalledWith({ ownerTelegramUserId: "telegram-101", telegramChatId: "group-101", title: "Группа" });
    expect(sendMessage).not.toHaveBeenCalled();

    prepare.mockResolvedValue(false);
    const second = telegramContext();
    await createTelegramMessageHandler(repository)(second.context, groupMessage(command));
    expect(second.sendMessage).toHaveBeenCalledWith(GROUP_CONNECT_REPLIES.registered);

    repository.groupConnect.command.mockResolvedValue("already");
    prepare.mockClear();
    const third = telegramContext();
    await createTelegramMessageHandler(repository)(third.context, groupMessage(command));
    expect(prepare).not.toHaveBeenCalled();
    expect(third.sendMessage).toHaveBeenCalledWith(GROUP_CONNECT_REPLIES.already);
  });

  it("replies with the refusal the command returns", async () => {
    const repository = repositories();
    repository.groupConnect.enabled = true;
    repository.groupConnect.command.mockResolvedValue("not_owner");
    const { context, sendMessage } = telegramContext();
    await createTelegramMessageHandler(repository)(context, groupMessage("/start group"));
    expect(sendMessage).toHaveBeenCalledWith(GROUP_CONNECT_REPLIES.not_owner);
  });

  it("does not connect for another bot or from a voice transcript", async () => {
    const repository = repositories();
    repository.groupConnect.enabled = true;
    await createTelegramMessageHandler(repository)(telegramContext().context, groupMessage("/start@other_bot group"));
    const voice: TelegramMessage = {
      ...groupMessage("/start group"),
      raw: { date: 1_700_000_000, voice: { file_id: "voice-1" } },
    };
    await createTelegramMessageHandler(repository)(telegramContext().context, voice);
    expect(repository.groupConnect.command).not.toHaveBeenCalled();
  });
});
