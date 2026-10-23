/** Version-pinned seam: every outbound Telegram Bot API call waits for its slot and survives a 429. */
import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";

type Replace = (path: string, before: string, after: string) => Promise<void>;

/** Published next to `api.js`, so the installed JavaScript imports it by a relative path. */
export const TELEGRAM_SEND_PACING_MODULE = "osinara-telegram-send-pacing.js";

// Eve 0.40.0 sends every Bot API request once and returns whatever Telegram answered, so a 429
// with `retry_after` (one private chat a second, twenty a minute to one group, about thirty a
// second in all) failed the delivery and the reply to the person was lost. The pacer takes a
// slot in the global and per-chat windows before each sending request, and a 429 pauses every
// call for the time Telegram names before this one is sent once more. Telegram received nothing
// from the refused request, so the single retry cannot duplicate a message; any other status,
// and a pause longer than a minute, go back to the caller untouched.
export async function patchTelegramSendPacing(
  replace: Replace,
  telegramDir = resolve("node_modules/eve/dist/src/public/channels/telegram"),
) {
  const runtime = stripTypeScriptTypes(await readFile("scripts/eve-runtime/telegram-send-pacing.ts", "utf8"));
  await writeFile(`${telegramDir}/${TELEGRAM_SEND_PACING_MODULE}`, runtime, "utf8");
  const api = `${telegramDir}/api.js`;
  await replace(api,
    'import{parseTelegramChatType}from"#public/channels/telegram/inbound.js";',
    `import{parseTelegramChatType}from"#public/channels/telegram/inbound.js";import{telegramRetryAfterSeconds,telegramSendPacer}from"./${TELEGRAM_SEND_PACING_MODULE}";`);
  await replace(api,
    "let a=await n(`${e.apiBaseUrl??`https://api.telegram.org`}/bot${r}/${encodeURIComponent(e.method)}`,i);return{body:await parseResponseBody(a),ok:a.ok,status:a.status}}",
    "let u=`${e.apiBaseUrl??`https://api.telegram.org`}/bot${r}/${encodeURIComponent(e.method)}`;await telegramSendPacer.acquire(e.method,e.body);let a=await n(u,i),s=await parseResponseBody(a);if(a.status===429){let t=telegramRetryAfterSeconds(s);if(t!==null&&telegramSendPacer.retryAfter(t)){await telegramSendPacer.waitForPause();await telegramSendPacer.acquire(e.method,e.body);a=await n(u,i);s=await parseResponseBody(a)}}return{body:s,ok:a.ok,status:a.status}}");
}
