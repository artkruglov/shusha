/**
 * Pacing of outbound Telegram Bot API calls under Telegram's limits (port of ilkruglov 602528c7, 0f354965).
 *
 * Exports:
 * - `createTelegramSendPacer`: a pacer with its own clock, for tests.
 * - `telegramSendPacerSettings`: the three limits from the environment, bounded by Telegram's.
 * - `telegramSendPacer`: the process-wide pacer; one instance per process even when this module is loaded
 *   twice (the copy next to Eve's `api.js` and the application's own import).
 * - `telegramRetryAfterSeconds`: the wait a 429 answer asks for, when it names one.
 * - `pacedTelegramSend`: one Bot API request under the pacer, repeated once after a 429; the installed copy
 *   also registers it on `globalThis` under `osinara.pacedTelegramSend`, because the application image has no
 *   `scripts/` tree and reaches the pacer only through Eve's channel (`agent/lib/telegram-send-pacer.ts`).
 *
 * Key construct:
 * - Telegram allows a bot about thirty messages a second in all, one a second to one private chat and twenty
 *   a minute to one group; above that it answers 429 with `retry_after`. Every message-sending method waits
 *   for a slot in the global window and in its own chat's window. Waiting is per call, so a group at its
 *   limit delays only its own messages, never another family's.
 * - A 429 naming a chat pauses only that chat; a 429 without a chat pauses every call (the global limit).
 *   The ilkruglov original paused every call on any 429, so one busy group stopped all families for up to a minute.
 * - A 429 means Telegram did not deliver, so the one repeat cannot duplicate a message.
 */
const PACED_METHODS = new Set([
  "copyMessage",
  "editMessageCaption",
  "editMessageMedia",
  "editMessageReplyMarkup",
  "editMessageText",
  "forwardMessage",
  "sendAnimation",
  "sendAudio",
  "sendDocument",
  "sendMediaGroup",
  "sendMessage",
  "sendPhoto",
  "sendRichMessage",
  "sendSticker",
  "sendVideo",
  "sendVoice",
]);
const GLOBAL_WINDOW_MS = 1_000;
const GROUP_WINDOW_MS = 60_000;
const RETRY_AFTER_MAX_SECONDS = 60;
const ACQUIRE_ROUNDS_MAX = 1_000;
const PACER_KEY = Symbol.for("osinara.telegramSendPacer");

const SETTING_BOUNDS = {
  TELEGRAM_SEND_GLOBAL_PER_SECOND: { absent: 25, max: 30, min: 1 },
  TELEGRAM_SEND_GROUP_PER_MINUTE: { absent: 20, max: 20, min: 1 },
  TELEGRAM_SEND_PRIVATE_GAP_MS: { absent: 250, max: 5_000, min: 0 },
} as const;

function integerSetting(
  name: keyof typeof SETTING_BOUNDS,
  env: Readonly<Record<string, string | undefined>>,
): number {
  const bounds = SETTING_BOUNDS[name];
  const raw = env[name];
  if (raw === undefined || raw === "") return bounds.absent;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`AGENT_RUNTIME_TUNING_INVALID: ${name} должно быть целым от ${bounds.min} до ${bounds.max}`);
  }
  return value;
}

/** The pacer limits an installation configured, with Telegram's own as the ceiling. */
export function telegramSendPacerSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Required<Pick<TelegramSendPacerOptions, "globalPerSecond" | "groupPerMinute" | "privateGapMs">> {
  return {
    globalPerSecond: integerSetting("TELEGRAM_SEND_GLOBAL_PER_SECOND", env),
    groupPerMinute: integerSetting("TELEGRAM_SEND_GROUP_PER_MINUTE", env),
    privateGapMs: integerSetting("TELEGRAM_SEND_PRIVATE_GAP_MS", env),
  };
}

export interface TelegramSendPacerOptions {
  /** Messages a second to all chats together; Telegram's limit is about thirty. */
  globalPerSecond?: number;
  /** Messages a minute to one group or channel; Telegram's limit is twenty. */
  groupPerMinute?: number;
  now?: () => number;
  /** Shortest gap between two messages to one private chat; Telegram tolerates short bursts. */
  privateGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TelegramSendPacer {
  /** Waits for a slot for this call; returns at once for methods that send nothing. */
  acquire(method: string, body: unknown): Promise<void>;
  /** Pauses the named chat, or every call when the body names none, until `seconds` from now. */
  retryAfter(body: unknown, seconds: number): void;
  /** Waits out the pause that applies to this chat (or the global one), whatever the method. */
  waitForPause(body: unknown): Promise<void>;
}

interface ChatKey {
  readonly group: boolean;
  readonly id: string;
}

function chatKey(body: unknown): ChatKey | null {
  if (typeof body !== "object" || body === null) return null;
  const chatId = (body as { chat_id?: unknown }).chat_id;
  if (typeof chatId !== "number" && typeof chatId !== "string") return null;
  const id = String(chatId);
  // Telegram gives groups, supergroups and channels negative ids; private chats positive ones.
  return { group: id.startsWith("-"), id };
}

export function createTelegramSendPacer(options: TelegramSendPacerOptions = {}): TelegramSendPacer {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const globalPerSecond = options.globalPerSecond ?? 25;
  const groupPerMinute = options.groupPerMinute ?? 20;
  const privateGapMs = options.privateGapMs ?? 250;
  const globalSends: number[] = [];
  const groupSends = new Map<string, number[]>();
  const privateLastSend = new Map<string, number>();
  const chatPauseUntil = new Map<string, number>();
  let globalPauseUntil = 0;

  function prune(sends: number[], windowMs: number, at: number): void {
    while (sends.length > 0 && sends[0]! <= at - windowMs) sends.shift();
  }

  function waitNeeded(at: number, chat: ChatKey | null): number {
    let wait = Math.max(0, globalPauseUntil - at);
    prune(globalSends, GLOBAL_WINDOW_MS, at);
    if (globalSends.length >= globalPerSecond) wait = Math.max(wait, globalSends[0]! + GLOBAL_WINDOW_MS - at);
    if (!chat) return wait;
    const paused = chatPauseUntil.get(chat.id);
    if (paused !== undefined) {
      if (paused <= at) chatPauseUntil.delete(chat.id);
      else wait = Math.max(wait, paused - at);
    }
    if (chat.group) {
      const sends = groupSends.get(chat.id) ?? [];
      prune(sends, GROUP_WINDOW_MS, at);
      if (sends.length === 0) groupSends.delete(chat.id);
      if (sends.length >= groupPerMinute) wait = Math.max(wait, sends[0]! + GROUP_WINDOW_MS - at);
    } else {
      const last = privateLastSend.get(chat.id);
      if (last !== undefined && last + privateGapMs <= at) privateLastSend.delete(chat.id);
      else if (last !== undefined) wait = Math.max(wait, last + privateGapMs - at);
    }
    return wait;
  }

  return {
    async acquire(method, body) {
      if (!PACED_METHODS.has(method)) return;
      const chat = chatKey(body);
      for (let round = 0; round < ACQUIRE_ROUNDS_MAX; round += 1) {
        const wait = waitNeeded(now(), chat);
        if (wait <= 0) break;
        await sleep(wait);
      }
      const at = now();
      globalSends.push(at);
      if (chat?.group) {
        const sends = groupSends.get(chat.id) ?? [];
        sends.push(at);
        groupSends.set(chat.id, sends);
      } else if (chat) {
        privateLastSend.set(chat.id, at);
      }
    },
    retryAfter(body, seconds) {
      const until = now() + Math.min(seconds, RETRY_AFTER_MAX_SECONDS) * 1_000;
      const chat = chatKey(body);
      if (chat) chatPauseUntil.set(chat.id, Math.max(chatPauseUntil.get(chat.id) ?? 0, until));
      else globalPauseUntil = Math.max(globalPauseUntil, until);
    },
    async waitForPause(body) {
      const chat = chatKey(body);
      const until = Math.max(globalPauseUntil, chat ? chatPauseUntil.get(chat.id) ?? 0 : 0);
      const wait = until - now();
      if (wait > 0) await sleep(wait);
    },
  };
}

export function telegramRetryAfterSeconds(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const parameters = (body as { parameters?: unknown }).parameters;
  if (typeof parameters !== "object" || parameters === null) return null;
  const seconds = (parameters as { retry_after?: unknown }).retry_after;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function processPacer(): TelegramSendPacer {
  const holder = globalThis as { [PACER_KEY]?: TelegramSendPacer };
  holder[PACER_KEY] ??= createTelegramSendPacer(telegramSendPacerSettings());
  return holder[PACER_KEY];
}

export const telegramSendPacer: TelegramSendPacer = {
  acquire: (method, body) => processPacer().acquire(method, body),
  retryAfter: (body, seconds) => processPacer().retryAfter(body, seconds),
  waitForPause: (body) => processPacer().waitForPause(body),
};

export interface PacedTelegramResponse {
  readonly body: unknown;
  readonly response: Response;
}

/**
 * Sends one Bot API request under the pacer. `body` only identifies the chat (`chat_id`); `send` performs the
 * request and may be called twice, the second time only after a 429 that named its wait.
 */
export async function pacedTelegramSend(
  method: string,
  body: unknown,
  send: () => Promise<Response>,
  parse: (response: Response) => Promise<unknown>,
  pacer: TelegramSendPacer = telegramSendPacer,
): Promise<PacedTelegramResponse> {
  await pacer.acquire(method, body);
  let response = await send();
  let parsed = await parse(response);
  if (response.status !== 429) return { body: parsed, response };
  const seconds = telegramRetryAfterSeconds(parsed);
  console.error(JSON.stringify({
    code: "AGENT_TELEGRAM_RATE_LIMITED",
    chatId: chatKey(body)?.id ?? null,
    method,
    retryAfterSeconds: seconds,
  }));
  if (seconds === null) return { body: parsed, response };
  pacer.retryAfter(body, seconds);
  await pacer.waitForPause(body);
  await pacer.acquire(method, body);
  response = await send();
  parsed = await parse(response);
  return { body: parsed, response };
}

(globalThis as { [key: symbol]: unknown })[Symbol.for("osinara.pacedTelegramSend")] = pacedTelegramSend;
