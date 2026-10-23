import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifiedWebAppUser } from "./init-data.js";

const TOKEN = "123456:test-token";
const NOW = new Date("2026-10-18T10:00:00Z");
const AUTH_DATE = String(NOW.getTime() / 1000 - 60);

/** Signs the way Telegram does, written out separately from the code under test. */
function signed(fields: Record<string, string>, token = TOKEN): string {
  const check = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const fields = {
  auth_date: AUTH_DATE,
  query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
  signature: "abc",
  user: JSON.stringify({ first_name: "Юля", id: 279058397, language_code: "ru" }),
};

describe("verifiedWebAppUser", () => {
  it("returns the user id from correctly signed data", () => {
    expect(verifiedWebAppUser(signed(fields), TOKEN, NOW)).toEqual({ telegramUserId: "279058397" });
  });

  it.each(Object.keys(fields))("refuses data where %s was changed after signing", (key) => {
    const params = new URLSearchParams(signed(fields));
    params.set(key, `${params.get(key)}x`);
    expect(() => verifiedWebAppUser(params.toString(), TOKEN, NOW)).toThrow("AGENT_WEB_APP_UNAUTHORIZED");
  });

  it("refuses data signed with another bot's token", () => {
    expect(() => verifiedWebAppUser(signed(fields, "999:other"), TOKEN, NOW)).toThrow("AGENT_WEB_APP_UNAUTHORIZED");
  });

  it("refuses a missing, malformed or repeated hash", () => {
    const params = new URLSearchParams(signed(fields));
    const hash = params.get("hash")!;
    params.delete("hash");
    expect(() => verifiedWebAppUser(params.toString(), TOKEN, NOW)).toThrow("AGENT_WEB_APP_UNAUTHORIZED");
    expect(() => verifiedWebAppUser(`${params}&hash=xyz`, TOKEN, NOW)).toThrow("AGENT_WEB_APP_UNAUTHORIZED");
    expect(() => verifiedWebAppUser(`${params}&hash=${hash}&hash=${hash}`, TOKEN, NOW)).toThrow("AGENT_WEB_APP_UNAUTHORIZED");
    expect(() => verifiedWebAppUser("", TOKEN, NOW)).toThrow("AGENT_WEB_APP_UNAUTHORIZED");
  });

  it("refuses data older than an hour and data from the future", () => {
    const old = String(NOW.getTime() / 1000 - 3601);
    expect(() => verifiedWebAppUser(signed({ ...fields, auth_date: old }), TOKEN, NOW)).toThrow("AGENT_WEB_APP_UNAUTHORIZED");
    const future = String(NOW.getTime() / 1000 + 600);
    expect(() => verifiedWebAppUser(signed({ ...fields, auth_date: future }), TOKEN, NOW)).toThrow("AGENT_WEB_APP_UNAUTHORIZED");
  });

  it("refuses signed data without a usable user", () => {
    const { user: _user, ...withoutUser } = fields;
    expect(() => verifiedWebAppUser(signed(withoutUser), TOKEN, NOW)).toThrow("AGENT_WEB_APP_UNAUTHORIZED");
    expect(() => verifiedWebAppUser(signed({ ...fields, user: "{" }), TOKEN, NOW)).toThrow("AGENT_WEB_APP_UNAUTHORIZED");
    expect(() => verifiedWebAppUser(signed({ ...fields, user: JSON.stringify({ id: "1" }) }), TOKEN, NOW)).toThrow("AGENT_WEB_APP_UNAUTHORIZED");
    expect(() => verifiedWebAppUser(signed({ ...fields, user: JSON.stringify({ id: 5, is_bot: true }) }), TOKEN, NOW)).toThrow("AGENT_WEB_APP_UNAUTHORIZED");
  });
});
