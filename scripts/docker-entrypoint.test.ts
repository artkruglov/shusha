/**
 * Start-time configuration checks of the agent container entrypoint.
 *
 * Constructs covered:
 * - The webhook secret and the internal token must be 32-256 characters of the Telegram
 *   secret_token alphabet before anything starts (security review, 5 October 2026), and the
 *   internal token must differ from the webhook secret Telegram holds. The Zod schema in
 *   agent/config.ts says the same but is not what refuses a start.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ENTRYPOINT = fileURLToPath(new URL("./docker-entrypoint.sh", import.meta.url));

const INTERNAL_TOKEN = "t".repeat(43);

function start(secret: string, internalToken = INTERNAL_TOKEN) {
  return spawnSync("sh", [ENTRYPOINT], {
    encoding: "utf8",
    env: {
      AGENT_INTERNAL_TOKEN: internalToken,
      DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused",
      INVITATION_SIGNING_SECRET: "i".repeat(32),
      MODEL_API_KEY: "unused",
      PATH: process.env.PATH,
      TELEGRAM_BOT_TOKEN: "1:unused",
      TELEGRAM_BOT_USERNAME: "unused",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: secret,
    },
    timeout: 20_000,
  });
}

describe("docker entrypoint", () => {
  it.each([
    ["shorter than 32 characters", "s".repeat(31)],
    ["outside the Telegram alphabet", `${"s".repeat(40)}!`],
    ["longer than Telegram accepts", "s".repeat(257)],
  ])("refuses a webhook secret %s", (_label, secret) => {
    const result = start(secret);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGENT_TELEGRAM_WEBHOOK_SECRET_WEAK");
  });

  it("passes a 43-character base64url secret, as the installer generates", () => {
    // It fails later (no model configuration here), but not on the secret.
    const result = start("A".repeat(21) + "-_" + "z".repeat(20));
    expect(result.stderr).not.toContain("AGENT_TELEGRAM_WEBHOOK_SECRET_WEAK");
    expect(result.stderr).not.toContain("AGENT_INTERNAL_TOKEN_WEAK");
  });

  it.each([
    ["shorter than 32 characters", "t".repeat(31)],
    ["equal to the webhook secret", "s".repeat(43)],
  ])("refuses an internal token %s", (_label, internalToken) => {
    const result = start("s".repeat(43), internalToken);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGENT_INTERNAL_TOKEN_WEAK");
  });
});
