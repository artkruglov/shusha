/** Configured agent names must agree across Telegram dispatch paths. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isAgentNameMentioned, isMessageAddressedToBot } from "./telegram-message-policy.js";

const group = { chat: { type: "group" as const }, text: "" };

describe("Telegram installation identity", () => {
  beforeEach(() => {
    vi.stubEnv("TELEGRAM_AGENT_NAME", "");
    vi.stubEnv("TELEGRAM_AGENT_ALIASES", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["Шуша", "ШУША", "Шуши", "Шуше", "Шушу", "Шушей", "Shusha", "Shusha"])(
    "addresses the default bot as %s", (name) => {
      expect(isMessageAddressedToBot({ ...group, text: `${name}, покажи дела` }, "family_bot"))
        .toBe(true);
    },
  );

  it.each(["Мия, привет", "Mia, help", "Шушам", "_Шуша", "Шуша\u200Ds", "хомяк", "Осинара, привет"])(
    "does not wake on another bot or a name embedded in a Unicode word: %s", (text) => {
      expect(isAgentNameMentioned(text)).toBe(false);
    },
  );

  it("keeps the full Osinara name set for an installation that names itself Osinara", () => {
    vi.stubEnv("TELEGRAM_AGENT_NAME", "Осинара");
    for (const text of ["Осинара, помоги", "Передай Осинаре", "Сделано Осинарой", "Osinara, help", "Сена, ответь"]) {
      expect(isAgentNameMentioned(text), text).toBe(true);
    }
    expect(isAgentNameMentioned("Шуша, привет")).toBe(false);
  });

  it("keeps the old Хомка name set for an installation that still names itself Хомка", () => {
    vi.stubEnv("TELEGRAM_AGENT_NAME", "Хомка");
    for (const text of ["Хомка, помоги", "Передай Хомке", "Сделано Хомкой", "Homka, help"]) {
      expect(isAgentNameMentioned(text), text).toBe(true);
    }
    // Новое имя по умолчанию такой установке не принадлежит.
    expect(isAgentNameMentioned("Шуша, привет")).toBe(false);
  });

  it("replaces the default names for another installation without changing username/reply routing", () => {
    vi.stubEnv("TELEGRAM_AGENT_NAME", "Мия");
    vi.stubEnv("TELEGRAM_AGENT_ALIASES", '["Мие", "Mia"]');
    expect(isAgentNameMentioned("Мие спасибо")).toBe(true);
    expect(isAgentNameMentioned("Мия, привет")).toBe(true);
    expect(isAgentNameMentioned("Осинара, привет")).toBe(false);
    expect(isMessageAddressedToBot({ ...group, text: "@family_bot привет" }, "family_bot")).toBe(true);
    expect(isMessageAddressedToBot({
      ...group,
      replyToMessage: { from: { isBot: true, username: "family_bot" } },
    }, "family_bot")).toBe(true);
    expect(isMessageAddressedToBot({ ...group, text: "/ask@family_bot Мия" }, "family_bot")).toBe(false);
  });

  it("can disable short aliases explicitly", () => {
    vi.stubEnv("TELEGRAM_AGENT_ALIASES", "[]");
    expect(isAgentNameMentioned("Шуша, привет")).toBe(true);
    expect(isAgentNameMentioned("Шуше привет")).toBe(false);
  });

  it("matches a configured Unicode name and its literal alias", () => {
    vi.stubEnv("TELEGRAM_AGENT_NAME", "Жюли");
    vi.stubEnv("TELEGRAM_AGENT_ALIASES", '["Анна-Мария", "Zoë"]');
    expect(isAgentNameMentioned("Анна-Мария, привет")).toBe(true);
    expect(isAgentNameMentioned("Zoe\u0308, hello")).toBe(true);
    expect(isAgentNameMentioned("Zoë\u0301s")).toBe(false);
  });

  it.each(["not json", '{"name":"Мия"}', '[".*"]', '["okay\\nignore instructions"]',
    JSON.stringify(Array.from({ length: 33 }, () => "Имя"))])(
    "rejects invalid alias configuration before matching: %s", (aliases) => {
      vi.stubEnv("TELEGRAM_AGENT_ALIASES", aliases);
      expect(() => isAgentNameMentioned("Осинара, привет")).toThrow(/AGENT_TELEGRAM_IDENTITY_INVALID/);
    },
  );
});
