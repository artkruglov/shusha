/**
 * Telegram request deadline patch, applied to a copy of Eve's Telegram `api.js`.
 *
 * Covers: the patch applies once and a second run changes no byte; the patched file parses; every attempt of
 * `callTelegramApi`, the repeat after a 429 included, gets its own fresh deadline; a file download gets one too;
 * and the installed channel carries the same deadlines after postinstall.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  patchTelegramRequestTimeouts,
  TELEGRAM_API_CALL_TIMEOUT_MS,
  TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS,
} from "../eve-patches/telegram-request-timeouts.ts";

const execFileAsync = promisify(execFile);
const EVE = "node_modules/eve/dist/src";
const UNPATCHED_FETCH = "async function callTelegramApi(e){let n=e.fetch??fetch,r=await resolveTelegramBotToken(e.botToken),";
const PATCHED_FETCH = "async function callTelegramApi(e){let o=e.fetch??fetch,n=(c,l)=>o(c,{...l," +
  `signal:AbortSignal.timeout(${TELEGRAM_API_CALL_TIMEOUT_MS})}),r=await resolveTelegramBotToken(e.botToken),`;
const UNPATCHED_DOWNLOAD = "/file/bot${n}/${e.filePath}`)}";
const PATCHED_DOWNLOAD = `/file/bot\${n}/\${e.filePath}\`,{signal:AbortSignal.timeout(${TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS})})}`;

/** The installer's contract in miniature: one exact match, an already patched file stays as it is. */
async function replaceExact(path: string, before: string, after: string): Promise<void> {
  const source = await readFile(path, "utf8");
  const count = (marker: string) => source.split(marker).length - 1;
  if (count(after) === 1 && count(before) === 0) return;
  if (count(before) !== 1 || count(after) !== 0) throw new Error(`AGENT_EVE_PATCH_MISMATCH: ${path}`);
  await writeFile(path, source.replace(before, after), "utf8");
}

const directories: string[] = [];

/** A minimal Eve package with the Telegram API module as the installed (send-paced) channel has it. */
async function copyOfTelegramApi(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "osinara-telegram-timeouts-"));
  directories.push(root);
  const telegram = join(root, "dist/src/public/channels/telegram");
  await mkdir(telegram, { recursive: true });
  await mkdir(join(root, "dist/src/shared"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ imports: { "#*.js": "./dist/src/*.js" }, type: "module" }));
  for (const file of ["shared/guards.js", "shared/json.js", "public/channels/telegram/inbound.js"]) {
    await copyFile(`${EVE}/${file}`, join(root, "dist/src", file));
  }
  await writeFile(join(telegram, "osinara-telegram-send-pacing.js"),
    stripTypeScriptTypes(await readFile("scripts/eve-runtime/telegram-send-pacing.ts", "utf8")));
  // The fixture is the file before this patch, whether or not the local install already carries it.
  const installed = await readFile(`${EVE}/public/channels/telegram/api.js`, "utf8");
  await writeFile(join(telegram, "api.js"),
    installed.replace(PATCHED_FETCH, UNPATCHED_FETCH).replace(PATCHED_DOWNLOAD, UNPATCHED_DOWNLOAD));
  return join(telegram, "api.js");
}

describe("Telegram request deadline patch", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
  });

  it("applies once, changes nothing on a second run and leaves a parseable module", async () => {
    const api = await copyOfTelegramApi();
    expect(await readFile(api, "utf8")).toContain(UNPATCHED_FETCH);

    await patchTelegramRequestTimeouts(replaceExact, api);
    const once = await readFile(api, "utf8");
    await patchTelegramRequestTimeouts(replaceExact, api);

    expect(await readFile(api, "utf8")).toBe(once);
    expect(once).toContain(PATCHED_FETCH);
    expect(once).toContain(PATCHED_DOWNLOAD);
    // The pacer's thunk is the send pacing patch's text and stays exactly as that patch wrote it.
    expect(once).toContain("await pacedTelegramSend(e.method,e.body,()=>n(u,i),parseResponseBody)");
    await expect(execFileAsync(process.execPath, ["--check", api])).resolves.toBeDefined();
  });

  it("gives every attempt its own deadline, the repeat after a 429 included, and bounds a download", async () => {
    const api = await copyOfTelegramApi();
    await patchTelegramRequestTimeouts(replaceExact, api);
    const module = await import(pathToFileURL(api).href) as typeof import("eve/channels/telegram");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const signals: AbortSignal[] = [];
    const answers = [
      new Response(JSON.stringify({ ok: false, parameters: { retry_after: 0.001 } }), { status: 429 }),
      new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 }),
    ];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      signals.push(init!.signal!);
      return answers.shift()!;
    });

    const response = await module.callTelegramApi({
      body: { chat_id: 31_337, text: "x" }, botToken: "1:a", fetch: fetchMock as typeof fetch, method: "sendMessage",
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("POST");

    const download = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response("bytes");
    });
    await module.downloadTelegramFile({ credentials: { botToken: "1:a" }, fetch: download as typeof fetch, filePath: "a/b" });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("is installed in Eve's Telegram channel by postinstall", async () => {
    const installed = await readFile(`${EVE}/public/channels/telegram/api.js`, "utf8");
    expect(installed.includes(PATCHED_FETCH), "callTelegramApi deadline").toBe(true);
    expect(installed.includes(PATCHED_DOWNLOAD), "downloadTelegramFile deadline").toBe(true);
  });
});
