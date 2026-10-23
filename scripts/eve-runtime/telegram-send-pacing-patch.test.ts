/** Installed-artifact contract for the Telegram send pacing patch of Eve's channel. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const TELEGRAM = "node_modules/eve/dist/src/public/channels/telegram";

describe("Telegram send pacing patch", () => {
  it("routes every channel Bot API call through the pacer", async () => {
    const api = await readFile(`${TELEGRAM}/api.js`, "utf8");
    expect(api).toContain('import{pacedTelegramSend}from"./osinara-telegram-send-pacing.js";');
    expect(api).toContain("await pacedTelegramSend(e.method,e.body,()=>n(u,i),parseResponseBody)");
    expect(api).not.toContain("let a=await n(`${e.apiBaseUrl");
    await expect(execFileAsync(process.execPath, ["--check", `${TELEGRAM}/api.js`])).resolves.toBeDefined();
  });

  it("shares one process-wide pacer between the installed copy and the application module", async () => {
    const installed = await import(pathToFileURL(resolve(`${TELEGRAM}/osinara-telegram-send-pacing.js`)).href) as typeof import("./telegram-send-pacing.js");
    const own = await import("./telegram-send-pacing.js");
    installed.telegramSendPacer.retryAfter({ chat_id: -987 }, 0.001);
    const started = Date.now();
    await own.telegramSendPacer.waitForPause({ chat_id: -987 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(installed.telegramSendPacerSettings({})).toEqual(own.telegramSendPacerSettings({}));
  });
});
