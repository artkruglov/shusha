/**
 * Pacing of outbound Telegram Bot API calls under Telegram's limits.
 *
 * Exports:
 * - `createTelegramSendPacer`: a pacer with its own clock, for tests.
 * - `telegramSendPacerSettings`: the three limits from the environment, bounded by Telegram's.
 * - `telegramSendPacer`: the process-wide pacer every Bot API call goes through.
 * - `telegramRetryAfterSeconds`: the wait a 429 answer asks for, when it names one.
 *
 * Key construct:
 * - Telegram allows a bot about thirty messages a second in all, one a second to one private
 *   chat and twenty a minute to one group; above that it answers 429 with `retry_after`. One
 *   family never comes near these, a thousand do (answers, progress notices, split long texts
 *   and reminders all count), so every message-sending method waits for a slot in a global
 *   window and in its chat's window before the request, and a 429 pauses every call for the
 *   time Telegram names (5 October 2026); a pause longer than a minute is not waited out, the
 *   429 goes back to the caller.
 * - The private-chat gap is a quarter of a second by default: Telegram tolerates short bursts,
 *   an answer of up to five parts is one, and a whole second between parts was a visible
 *   delay for one family. The three limits are environment settings; an installation serving
 *   a thousand families sets the gap to the full second.
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
  "sendSticker",
  "sendVideo",
  "sendVoice",
]);
const GLOBAL_WINDOW_MS = 1_000;
const GROUP_WINDOW_MS = 60_000;
const RETRY_AFTER_MAX_SECONDS = 60;
const PRUNE_EVERY_ACQUIRES = 1_000;

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
  if (raw === undefined) return bounds.absent;
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
  /** Shortest gap between two messages to one private chat; Telegram names one a second and
   * tolerates short bursts. */
  privateGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TelegramSendPacer {
  /** Waits for a slot for this call, in arrival order; returns at once for methods that send nothing. */
  acquire(method: string, body: unknown): Promise<void>;
  /**
   * Pauses every call until `seconds` from now, as a 429 answer asked; false when the wait is
   * longer than the cap, in which case the caller gives the answer back instead of retrying.
   */
  retryAfter(seconds: number): boolean;
  /** Waits out the pause, including one extended by another 429 meanwhile. */
  waitForPause(): Promise<void>;
}

function chatKey(body: unknown): { id: string; group: boolean } | null {
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
  let pauseUntil = 0;
  // Callers take slots in arrival order: one waiter at a time computes its wait and sleeps,
  // the next one starts after it, so a steady stream to one chat cannot starve another call
  // (Codex review, 5 October 2026).
  let queue: Promise<void> = Promise.resolve();
  let acquires = 0;

  /** Drops chats that have been quiet for their whole window, so the maps stay bounded. */
  function prune(at: number): void {
    for (const [id, last] of privateLastSend) {
      if (last + privateGapMs <= at) privateLastSend.delete(id);
    }
    for (const [id, sends] of groupSends) {
      pruneSends(sends, GROUP_WINDOW_MS, at);
      if (sends.length === 0) groupSends.delete(id);
    }
  }

  function pruneSends(sends: number[], windowMs: number, at: number): void {
    while (sends.length > 0 && sends[0]! <= at - windowMs) sends.shift();
  }

  function waitNeeded(at: number, chat: { id: string; group: boolean } | null): number {
    let wait = Math.max(0, pauseUntil - at);
    pruneSends(globalSends, GLOBAL_WINDOW_MS, at);
    if (globalSends.length >= globalPerSecond) wait = Math.max(wait, globalSends[0]! + GLOBAL_WINDOW_MS - at);
    if (chat?.group) {
      const sends = groupSends.get(chat.id) ?? [];
      pruneSends(sends, GROUP_WINDOW_MS, at);
      if (sends.length >= groupPerMinute) wait = Math.max(wait, sends[0]! + GROUP_WINDOW_MS - at);
    } else if (chat) {
      const last = privateLastSend.get(chat.id);
      if (last !== undefined) wait = Math.max(wait, last + privateGapMs - at);
    }
    return wait;
  }

  async function takeSlot(chat: { id: string; group: boolean } | null): Promise<void> {
    // Only this waiter takes slots while it holds the queue, so the wait converges.
    for (;;) {
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
    acquires += 1;
    if (acquires % PRUNE_EVERY_ACQUIRES === 0) prune(at);
  }

  return {
    acquire(method, body) {
      if (!PACED_METHODS.has(method)) return Promise.resolve();
      const turn = queue.then(() => takeSlot(chatKey(body)));
      queue = turn.catch(() => undefined);
      return turn;
    },
    retryAfter(seconds) {
      if (seconds > RETRY_AFTER_MAX_SECONDS) return false;
      pauseUntil = Math.max(pauseUntil, now() + seconds * 1_000);
      return true;
    },
    async waitForPause() {
      for (;;) {
        const wait = pauseUntil - now();
        if (wait <= 0) return;
        await sleep(wait);
      }
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

export const telegramSendPacer: TelegramSendPacer = createTelegramSendPacer(telegramSendPacerSettings());
