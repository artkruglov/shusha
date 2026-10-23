/**
 * Where the Mini App lives, and the bot's menu button «Дела» that opens it.
 *
 * Exports:
 * - `webAppUrl`: the page's https address from `PUBLIC_BASE_URL`, or null when the address is not configured.
 * - `ensureWebAppMenuButton`: sets the default menu button to the page once, if Telegram has another one.
 *
 * Without a public https address there is no Mini App: no menu button and no «Доска» under the overview,
 * and chat buttons work as before. The menu button is the bot's default for every private chat
 * (`setChatMenuButton` without `chat_id`); it is read first, so the hourly check writes nothing when it
 * is already in place.
 */
import { AppError } from "../app-error.js";

export const WEB_APP_PATH = "/app/";
export const WEB_APP_MENU_TEXT = "Дела";
const TELEGRAM_TIMEOUT_MS = 10_000;

export function webAppUrl(environment: NodeJS.ProcessEnv = process.env): string | null {
  const raw = environment.PUBLIC_BASE_URL;
  if (!raw) return null;
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    return null;
  }
  // Telegram opens Mini Apps only over https; a misconfigured address means no Mini App, not a broken one.
  if (base.protocol !== "https:" || base.pathname !== "/" || base.search || base.hash) return null;
  return new URL(WEB_APP_PATH, base).toString();
}

interface MenuButton {
  text?: string;
  type: string;
  web_app?: { url: string };
}

export async function ensureWebAppMenuButton(input: {
  botToken: string;
  fetch?: typeof fetch;
  url: string | null;
}): Promise<"absent" | "set" | "unchanged"> {
  if (input.url === null) return "absent";
  const call = async (method: string, body: object) => {
    const response = await (input.fetch ?? fetch)(`https://api.telegram.org/bot${input.botToken}/${method}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null) as { ok?: boolean; result?: unknown } | null;
    if (!response.ok || payload?.ok !== true) {
      throw new AppError("AGENT_WEB_APP_MENU_FAILED", `Telegram не принял ${method} (HTTP ${response.status})`);
    }
    return payload.result;
  };
  const current = await call("getChatMenuButton", {}) as MenuButton;
  if (current.type === "web_app" && current.web_app?.url === input.url && current.text === WEB_APP_MENU_TEXT) {
    return "unchanged";
  }
  await call("setChatMenuButton", {
    menu_button: { text: WEB_APP_MENU_TEXT, type: "web_app", web_app: { url: input.url } },
  });
  return "set";
}
