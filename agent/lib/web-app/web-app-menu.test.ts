import { describe, expect, it } from "vitest";

import { ensureWebAppMenuButton, webAppUrl } from "./web-app-menu.js";

describe("webAppUrl", () => {
  it("builds the page address only from a bare https origin", () => {
    expect(webAppUrl({ PUBLIC_BASE_URL: "https://family.example.org/" })).toBe("https://family.example.org/app/");
    expect(webAppUrl({ PUBLIC_BASE_URL: "https://family.example.org" })).toBe("https://family.example.org/app/");
    expect(webAppUrl({})).toBeNull();
    expect(webAppUrl({ PUBLIC_BASE_URL: "http://family.example.org/" })).toBeNull();
    expect(webAppUrl({ PUBLIC_BASE_URL: "https://family.example.org/eve/" })).toBeNull();
    expect(webAppUrl({ PUBLIC_BASE_URL: "not a url" })).toBeNull();
  });
});

describe("ensureWebAppMenuButton", () => {
  function telegram(current: object) {
    const calls: Array<{ body: unknown; method: string }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      const method = url.split("/").at(-1)!;
      calls.push({ body: JSON.parse(String(init.body)), method });
      return Response.json({ ok: true, result: method === "getChatMenuButton" ? current : true });
    }) as unknown as typeof fetch;
    return { calls, fetcher };
  }

  it("sets the button when Telegram shows the commands menu", async () => {
    const { calls, fetcher } = telegram({ type: "commands" });
    await expect(ensureWebAppMenuButton({ botToken: "t", fetch: fetcher, url: "https://h/app/" })).resolves.toBe("set");
    expect(calls.at(-1)).toEqual({
      body: { menu_button: { text: "Дела", type: "web_app", web_app: { url: "https://h/app/" } } },
      method: "setChatMenuButton",
    });
  });

  it("writes nothing when the button is already in place, and nothing without an address", async () => {
    const { calls, fetcher } = telegram({ text: "Дела", type: "web_app", web_app: { url: "https://h/app/" } });
    await expect(ensureWebAppMenuButton({ botToken: "t", fetch: fetcher, url: "https://h/app/" })).resolves.toBe("unchanged");
    expect(calls.map((call) => call.method)).toEqual(["getChatMenuButton"]);
    await expect(ensureWebAppMenuButton({ botToken: "t", fetch: fetcher, url: null })).resolves.toBe("absent");
    expect(calls).toHaveLength(1);
  });
});
