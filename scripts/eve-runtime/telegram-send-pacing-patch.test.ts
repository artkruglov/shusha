/**
 * Installed-artifact contract for the Telegram send pacing patch.
 *
 * The shared node_modules of this checkout is never patched here: the installer's seam is applied
 * to a temporary copy of the pristine-or-patched `api.js`, with the installer's own count-checked
 * replacement rules, and the patched copy is exercised against a fake Telegram.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TELEGRAM_SEND_PACING_MODULE, patchTelegramSendPacing } from "../eve-patches/telegram-send-pacing.ts";

const execFileAsync = promisify(execFile);
const INSTALLED_API = resolve("node_modules/eve/dist/src/public/channels/telegram/api.js");
const UNPATCHED_CALL = "let a=await n(`${e.apiBaseUrl??`https://api.telegram.org`}/bot${r}/${encodeURIComponent(e.method)}`,i);return{body:await parseResponseBody(a),ok:a.ok,status:a.status}}";

// Mirrors `replaceExact` of scripts/apply-eve-patches.ts, which cannot be imported without running
// every patch against the installed Eve.
async function replaceExact(path: string, before: string, after: string): Promise<void> {
  const source = await readFile(path, "utf8");
  const count = (marker: string) => source.split(marker).length - 1;
  const unpatched = count(before) - count(after) * (after.split(before).length - 1);
  if (unpatched === 0 && count(after) === 1) return;
  if (unpatched !== 1 || count(after) !== 0) throw new Error(`AGENT_EVE_PATCH_MISMATCH: ${path}`);
  await writeFile(path, source.split(before).join(after), "utf8");
}

describe("Telegram send pacing patch", () => {
  let dir: string;
  let api: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "telegram-send-pacing-"));
    api = join(dir, "api.js");
    await copyFile(INSTALLED_API, api);
    // The installed artifact may already carry the patch on a checkout whose postinstall ran.
    const installed = await readFile(api, "utf8");
    expect(installed.includes(UNPATCHED_CALL) || installed.includes(`./${TELEGRAM_SEND_PACING_MODULE}`)).toBe(true);
    await patchTelegramSendPacing(replaceExact, dir);
  });

  afterAll(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("routes every Bot API call through the pacer and retries once after a 429 with retry_after", async () => {
    const patched = await readFile(api, "utf8");
    expect(patched).toContain(`import{telegramRetryAfterSeconds,telegramSendPacer}from"./${TELEGRAM_SEND_PACING_MODULE}";`);
    expect(patched).toContain("await telegramSendPacer.acquire(e.method,e.body);let a=await n(u,i)");
    expect(patched).toContain("if(a.status===429){let t=telegramRetryAfterSeconds(s);if(t!==null&&telegramSendPacer.retryAfter(t)){await telegramSendPacer.waitForPause();await telegramSendPacer.acquire(e.method,e.body);a=await n(u,i);");
    expect(patched).not.toContain(UNPATCHED_CALL);
    await expect(execFileAsync(process.execPath, ["--check", api])).resolves.toBeDefined();
    await expect(execFileAsync(process.execPath, ["--check", join(dir, TELEGRAM_SEND_PACING_MODULE)])).resolves.toBeDefined();
  });

  it("is idempotent: a second application leaves both artifacts byte-identical", async () => {
    const before = await Promise.all([readFile(api, "utf8"), readFile(join(dir, TELEGRAM_SEND_PACING_MODULE), "utf8")]);
    await patchTelegramSendPacing(replaceExact, dir);
    const after = await Promise.all([readFile(api, "utf8"), readFile(join(dir, TELEGRAM_SEND_PACING_MODULE), "utf8")]);
    expect(after).toEqual(before);
  });

  it("installs a self-contained runtime module with the process-wide pacer", async () => {
    const runtime = await import(pathToFileURL(join(dir, TELEGRAM_SEND_PACING_MODULE)).href) as typeof import("./telegram-send-pacing.ts");
    expect(runtime.telegramRetryAfterSeconds({ ok: false, parameters: { retry_after: 3 } })).toBe(3);
    expect(typeof runtime.telegramSendPacer.acquire).toBe("function");
  });

  it("waits out retry_after and sends the refused request once more; other failures return as they are", async () => {
    // Eve's internal `#shared` imports resolve only inside the package; the patched copy is loaded
    // with those three helpers inlined, so the real callTelegramApi runs against a fake fetch.
    const loadable = join(dir, "api.loadable.mjs");
    const patched = await readFile(api, "utf8");
    await writeFile(loadable, patched
      .replace('import{isObject}from"#shared/guards.js";', "const isObject=e=>typeof e==`object`&&e!==null;")
      .replace('import{parseJsonObject}from"#shared/json.js";', "const parseJsonObject=e=>e;")
      .replace('import{parseTelegramChatType}from"#public/channels/telegram/inbound.js";', "const parseTelegramChatType=()=>void 0;"), "utf8");
    const { callTelegramApi } = await import(pathToFileURL(loadable).href) as typeof import("../../node_modules/eve/dist/src/public/channels/telegram/api.js");
    const answers: { body: Record<string, unknown>; status: number }[] = [
      { body: { ok: false, parameters: { retry_after: 1 } }, status: 429 },
      { body: { ok: true, result: { message_id: 7 } }, status: 200 },
    ];
    const calls: number[] = [];
    const fetchStub = async () => {
      calls.push(Date.now());
      const answer = answers.shift()!;
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    };
    const started = Date.now();
    const result = await callTelegramApi({ body: { chat_id: 5, text: "hi" }, botToken: "t", fetch: fetchStub as never, method: "sendMessage" });
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]! - started).toBeGreaterThanOrEqual(950);

    // A 429 without retry_after, and any other failure, are not retried: the caller decides.
    answers.push({ body: { ok: false }, status: 429 });
    calls.length = 0;
    const refused = await callTelegramApi({ body: { file_id: "x" }, botToken: "t", fetch: fetchStub as never, method: "getFile" });
    expect(refused.status).toBe(429);
    expect(calls).toHaveLength(1);
  });
});
