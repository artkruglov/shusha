/**
 * Every Bot API call of Eve's Telegram channel goes through the process-wide send pacer.
 *
 * Eve 0.40.0 neither paces outbound calls nor reads `retry_after`, so a busy group could draw 429 answers
 * and lose messages. ilkruglov paced the channel (602528c7, 0f354965, 4 October 2026); here the module
 * lives in scripts/eve-runtime (typechecked, tested), this patch copies it with types stripped next to
 * Eve's `api.js`, and `callTelegramApi` delegates the request to `pacedTelegramSend`. The application's
 * direct multipart sends import the same module; both copies share one pacer through `globalThis`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";

const TELEGRAM = resolve("node_modules/eve/dist/src/public/channels/telegram");

export async function patchTelegramSendPacing(
  replace: (path: string, before: string, after: string) => Promise<void>,
): Promise<void> {
  const source = await readFile("scripts/eve-runtime/telegram-send-pacing.ts", "utf8");
  await writeFile(`${TELEGRAM}/osinara-telegram-send-pacing.js`, stripTypeScriptTypes(source), "utf8");
  const api = `${TELEGRAM}/api.js`;
  await replace(api,
    'import{isObject}from"#shared/guards.js";',
    'import{isObject}from"#shared/guards.js";import{pacedTelegramSend}from"./osinara-telegram-send-pacing.js";');
  await replace(api,
    "let a=await n(`${e.apiBaseUrl??`https://api.telegram.org`}/bot${r}/${encodeURIComponent(e.method)}`,i);return{body:await parseResponseBody(a),ok:a.ok,status:a.status}}",
    "let u=`${e.apiBaseUrl??`https://api.telegram.org`}/bot${r}/${encodeURIComponent(e.method)}`,{body:s,response:a}=await pacedTelegramSend(e.method,e.body,()=>n(u,i),parseResponseBody);return{body:s,ok:a.ok,status:a.status}}");
}
