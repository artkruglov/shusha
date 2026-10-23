/**
 * Второе @имя бота (`TELEGRAM_BOT_USERNAME_ALIASES`).
 *
 * Проверяется: у Юны два имени, и обращение по любому из них доходит в группе (упоминание, ответ на сообщение
 * бота, `/команда@имя`), в приглашении и в гостевом вызове, а чужой бот своим не становится. Неверное имя в
 * окружении останавливает запуск, а не молча пропадает.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseGuestMessage } from "./guest/guest-message.js";
import { parseInvitationStartCommand } from "./invitation-code.js";
import { isOwnBotUsername, telegramBotUsernames } from "./telegram-bot-usernames.js";
import { parseFamilylessGroupCommand } from "./telegram-familyless-group-command.js";
import { parseGroupConnectCommand } from "./telegram-group-connect-command.js";
import { mentionsAnotherUsername, telegramGroupTurnTrigger } from "./telegram-message-policy.js";

const PRIMARY = "yuna_agentbot";
const group = { chat: { id: "-1001", type: "group" as const }, replyToMessage: undefined };
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.TELEGRAM_BOT_USERNAME_ALIASES;
  process.env.TELEGRAM_BOT_USERNAME_ALIASES = "yuna_agent";
});
afterEach(() => {
  if (saved === undefined) delete process.env.TELEGRAM_BOT_USERNAME_ALIASES;
  else process.env.TELEGRAM_BOT_USERNAME_ALIASES = saved;
});

describe("bot usernames", () => {
  it("knows the primary name and the aliases, once each and in any case", () => {
    expect(telegramBotUsernames(PRIMARY, { TELEGRAM_BOT_USERNAME_ALIASES: " @Yuna_Agent, yuna_agentbot ," }))
      .toEqual(["yuna_agentbot", "yuna_agent"]);
    expect(telegramBotUsernames(PRIMARY, {})).toEqual(["yuna_agentbot"]);
    expect(isOwnBotUsername("YUNA_AGENT", PRIMARY)).toBe(true);
    expect(isOwnBotUsername("yuna_agent_fake", PRIMARY)).toBe(false);
    expect(isOwnBotUsername(undefined, PRIMARY)).toBe(false);
  });

  it("refuses a malformed alias instead of ignoring it", () => {
    expect(() => telegramBotUsernames(PRIMARY, { TELEGRAM_BOT_USERNAME_ALIASES: "юна" }))
      .toThrow(/TELEGRAM_BOT_USERNAME_ALIASES/u);
  });

  it("answers a group mention and a reply by either name, but not another bot", () => {
    expect(telegramGroupTurnTrigger({ ...group, text: "@yuna_agent что на завтра?" }, PRIMARY)).toBe("mention");
    expect(telegramGroupTurnTrigger({ ...group, text: "@yuna_agentbot что на завтра?" }, PRIMARY)).toBe("mention");
    expect(mentionsAnotherUsername("@yuna_agent глянь", PRIMARY)).toBe(false);
    expect(mentionsAnotherUsername("@other_bot глянь", PRIMARY)).toBe(true);
    const reply = (username: string) => ({
      ...group,
      replyToMessage: { from: { id: "1", isBot: true, username } },
      text: "а ещё?",
    }) as unknown as Parameters<typeof telegramGroupTurnTrigger>[0];
    expect(telegramGroupTurnTrigger(reply("yuna_agent"), PRIMARY)).toBe("reply_to_agent");
    expect(telegramGroupTurnTrigger(reply("other_bot"), PRIMARY)).toBeNull();
  });

  it("takes commands and invitations addressed to either name", () => {
    expect(parseGroupConnectCommand("/start@yuna_agent group", PRIMARY)).toBe(true);
    expect(parseGroupConnectCommand("/start@other_bot group", PRIMARY)).toBe(false);
    expect(parseFamilylessGroupCommand("/stop@yuna_agent", PRIMARY)).toBe("stop");
    expect(parseFamilylessGroupCommand("/stop@other_bot", PRIMARY)).toBeNull();
    const token = "a".repeat(32);
    expect(parseInvitationStartCommand(`/start@yuna_agent ${token}`, PRIMARY)).toBe(token);
    expect(parseInvitationStartCommand(`/start@other_bot ${token}`, PRIMARY)).toBeNull();
  });

  it("cuts either name out of a guest question and knows its own earlier answer", () => {
    const guest = (text: string, replyFrom?: string) => parseGuestMessage({
      chat: { id: -100, type: "group" },
      date: 1_700_000_000,
      from: { first_name: "Артём", id: 101, is_bot: false },
      guest_query_id: "guest-1",
      message_id: 9,
      ...replyFrom ? { reply_to_message: { date: 1_700_000_000, from: { id: 7, is_bot: true, username: replyFrom }, message_id: 8, text: "раньше" } } : {},
      text,
    }, PRIMARY);
    expect(guest("@yuna_agent какая погода?").question).toBe("какая погода?");
    expect(guest("@yuna_agentbot какая погода?").question).toBe("какая погода?");
    expect(guest("@yuna_agent а это?", "yuna_agent").quoted?.fromSelf).toBe(true);
  });
});
