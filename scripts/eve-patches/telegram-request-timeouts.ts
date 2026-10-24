/**
 * Every Bot API call of Eve's Telegram channel and every file download carry a deadline.
 *
 * Eve 0.40.0 calls `fetch` without a signal in `callTelegramApi` and `downloadTelegramFile`, and Node's fetch
 * waits up to 300 s for response headers, so one stuck request held a turn for five minutes.
 *
 * `callTelegramApi` binds its fetch to a wrapper that creates `AbortSignal.timeout` on every call. The pacer's
 * thunk `()=>n(u,i)` calls it once per attempt, so the one repeat after a 429 gets a fresh full deadline
 * instead of the remains of the first. The wrapper replaces the fetch binding rather than the thunk text: the
 * thunk belongs to the send pacing patch, and rewriting another patch's output would make that patch fail
 * its own idempotence check on the next postinstall. A download gets a longer deadline for its body. A
 * caller that passes its own `fetch` and sets its own signal keeps it: the deadline only fills the request
 * init it receives.
 */
import { resolve } from "node:path";

export const TELEGRAM_API_CALL_TIMEOUT_MS = 30_000;
export const TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS = 120_000;

const API = resolve("node_modules/eve/dist/src/public/channels/telegram/api.js");

export async function patchTelegramRequestTimeouts(
  replace: (path: string, before: string, after: string) => Promise<void>,
  api: string = API,
): Promise<void> {
  await replace(api,
    "async function callTelegramApi(e){let n=e.fetch??fetch,r=await resolveTelegramBotToken(e.botToken),",
    "async function callTelegramApi(e){let o=e.fetch??fetch,n=(c,l)=>o(c,{...l," +
      `signal:AbortSignal.timeout(${TELEGRAM_API_CALL_TIMEOUT_MS})}),r=await resolveTelegramBotToken(e.botToken),`);
  await replace(api,
    "return t(`${e.fileBaseUrl??e.apiBaseUrl??`https://api.telegram.org`}/file/bot${n}/${e.filePath}`)}",
    "return t(`${e.fileBaseUrl??e.apiBaseUrl??`https://api.telegram.org`}/file/bot${n}/${e.filePath}`," +
      `{signal:AbortSignal.timeout(${TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS})})}`);
}
