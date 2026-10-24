/**
 * A verified `my_chat_member` update reaches the application instead of Eve's silent drop.
 *
 * Telegram sends it when a person blocks or unblocks the bot in a private chat and when the bot is removed
 * from or added to a group (Bot API 10.3, `Update.my_chat_member`). Eve 0.40.0 parses only messages and
 * button presses and acknowledged it with `ok`, so the application learned of a blocked bot only from the
 * next failed send. `onMyChatMember` runs after the webhook secret check and JSON parsing, before Eve's own
 * parsing; the update carries no message, so the hook gets the raw body and `waitUntil`, never a dispatcher.
 *
 * Both replacements anchor next to, not inside, the text other patches wrote (the guest/join-request seam
 * and the hook declarations): rewriting another patch's output would make that patch fail its own
 * idempotence check on the next postinstall, and an installation patched before 24 October 2026 must take
 * this one without a reinstall of Eve.
 */
import { resolve } from "node:path";

const TELEGRAM = resolve("node_modules/eve/dist/src/public/channels/telegram");

export async function patchTelegramMyChatMember(
  replace: (path: string, before: string, after: string) => Promise<void>,
): Promise<void> {
  const parsed = "return log.warn(`inbound Telegram body is not valid JSON`,{error:e}),new Response(`ok`)}";
  await replace(`${TELEGRAM}/telegramChannel.js`,
    `${parsed}let u=parseTelegramUpdate(c);`,
    `${parsed}if(e.onMyChatMember!==void 0&&c.my_chat_member!==void 0)return e.onMyChatMember({raw:c,waitUntil:o});` +
      "let u=parseTelegramUpdate(c);");
  const previous = "    readonly onCallbackQuery?: (ctx: TelegramContext, query: TelegramCallbackQuery) => void | Promise<void>;\n";
  const next = "    /** Optional internal endpoint that resumes persisted ingress after process restarts. */";
  await replace(`${TELEGRAM}/telegramChannel.d.ts`, `${previous}${next}`,
    `${previous}    /** Runs after webhook verification for a \`my_chat_member\`, which Eve does not parse. */\n` +
      "    readonly onMyChatMember?: (context: { readonly raw: JsonObject; readonly waitUntil: (task: Promise<unknown>) => void; }) => Response | Promise<Response>;\n" +
      next);
}
