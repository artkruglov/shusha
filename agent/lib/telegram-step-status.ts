/**
 * One status message that lists the steps of a long turn and disappears when the answer arrives.
 *
 * Exports:
 * - `describeTelegramStep`: the line a requested action shows, or null for quick bookkeeping.
 * - `renderTelegramSteps`: the status text for a list of steps.
 * - `createTelegramStepStatus`: the per-turn status with an injected clock and transport, for tests.
 * - `telegramStepStatus`: the process-wide instance the channel uses.
 *
 * Key construct:
 * - Owner decision of 13 October 2026 (competitor review: Spru shows its steps): the application, not
 *   the model, writes the status from the names of the tools the turn calls, so it costs no tokens and
 *   cannot drift from what actually runs. Only a search query and a site's domain come from the call.
 * - A turn that answers within `appearAfterMs` never shows it; a longer one gets one silent message
 *   that is edited as steps advance, no more often than `editGapMs` (a group allows twenty sends a
 *   minute in all, edits included), and deleted at the answer, a confirmation prompt, a failure or a
 *   cancellation. All operations of one turn run in order, so a deletion never overtakes the send.
 * - State is process memory. A turn that moves to another worker leaves its status message behind;
 *   that is the accepted cost of keeping no new persisted contract for a cosmetic message.
 */
const APPEAR_AFTER_MS = 8_000;
const SHOWN_STEPS = 6;
const QUERY_MAX_CHARACTERS = 40;
const STALE_TURN_MS = 30 * 60_000;
/** A terminal event never waits longer than this for Telegram to delete a cosmetic message. */
const CLOSE_WAIT_MS = 5_000;

export interface TelegramStepAction {
  readonly input?: unknown;
  readonly kind: string;
  readonly toolName?: string;
}

const TOOL_LINES: Readonly<Record<string, string>> = {
  bash: "⚙️ Считаю и обрабатываю",
  execute_google_workspace: "📧 Работаю с Google",
  generate_image: "🎨 Рисую картинку",
  generate_video: "🎬 Делаю видео",
  glob: "📄 Читаю файлы",
  grep: "📄 Читаю файлы",
  grocery_cart: "🛒 Собираю корзину",
  import_telegram_attachment: "📎 Беру файл из чата",
  inspect_workspace_image: "🖼 Смотрю картинку",
  list_group_history: "💬 Читаю историю чата",
  manage_errand: "📋 Оформляю поручение",
  manage_gmail_message: "📧 Работаю с почтой",
  read_file: "📄 Читаю файлы",
  read_scheduled_group_history: "💬 Читаю историю чата",
  send_workspace_file: "📎 Отправляю файл",
  write_file: "📝 Готовлю файл",
};

function field(input: unknown, name: string): string | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function domain(input: unknown): string | null {
  const url = field(input, "url");
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./u, "") || null;
  } catch {
    return null;
  }
}

function shorten(text: string): string {
  const points = Array.from(text.replace(/\s+/gu, " "));
  return points.length <= QUERY_MAX_CHARACTERS ? points.join("") : `${points.slice(0, QUERY_MAX_CHARACTERS - 1).join("")}…`;
}

export function describeTelegramStep(action: TelegramStepAction): string | null {
  if (action.kind === "subagent-call" || action.kind === "remote-agent-call") return "🤝 Подключаю помощника";
  if (action.kind !== "tool-call" || !action.toolName) return null;
  switch (action.toolName) {
    case "web_search": {
      const query = field(action.input, "query");
      return query ? `🔎 Ищу: ${shorten(query)}` : "🔎 Ищу в интернете";
    }
    case "web_fetch": {
      const site = domain(action.input);
      return site ? `🌐 Открываю ${site}` : "🌐 Открываю сайт";
    }
    case "browser": {
      const site = domain(action.input);
      return site ? `🧭 Браузер: ${site}` : "🧭 Работаю в браузере";
    }
    case "agent":
      return "🤝 Подключаю помощника";
    default:
      return TOOL_LINES[action.toolName] ?? null;
  }
}

interface Step {
  readonly batch: number;
  readonly line: string;
}

export function renderTelegramSteps(steps: readonly Step[]): string {
  const current = steps.at(-1)?.batch;
  // A repeated line in a row is one line with a count: five searches for the same thing are one step.
  const lines: { count: number; done: boolean; line: string }[] = [];
  for (const step of steps) {
    const done = step.batch !== current;
    const last = lines.at(-1);
    if (last && last.line === step.line && last.done === done) last.count += 1;
    else lines.push({ count: 1, done, line: step.line });
  }
  const hidden = Math.max(0, lines.length - SHOWN_STEPS);
  const shown = lines.slice(hidden).map((entry) =>
    `${entry.line}${entry.count > 1 ? ` ×${entry.count}` : ""}${entry.done ? " ✓" : "…"}`);
  return [...(hidden > 0 ? [`✓ ещё шагов: ${hidden}`] : []), ...shown].join("\n");
}

export interface TelegramStepStatusTransport {
  /** Sends the status without a notification; returns its message id, or null if it was not sent. */
  send(text: string): Promise<number | null>;
  edit(messageId: number, text: string): Promise<void>;
  remove(messageId: number): Promise<void>;
}

export interface TelegramStepStatusClock {
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
}

interface TurnStatus {
  batches: number;
  chain: Promise<void>;
  closed: boolean;
  editGapMs: number;
  lastSentAt: number;
  messageId: number | null;
  rendered: string;
  startedAt: number;
  steps: Step[];
  timer: ReturnType<typeof setTimeout> | null;
  transport: TelegramStepStatusTransport | null;
}

const systemClock: TelegramStepStatusClock = {
  clearTimeout: (handle) => clearTimeout(handle),
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
};

function logFailure(code: string, error: unknown): void {
  console.error(JSON.stringify({ code, error: error instanceof Error ? error.message : String(error) }));
}

export function createTelegramStepStatus(
  clock: TelegramStepStatusClock = systemClock,
  options: { appearAfterMs?: number } = {},
) {
  const appearAfterMs = options.appearAfterMs ?? APPEAR_AFTER_MS;
  const turns = new Map<string, TurnStatus>();

  function sweep(): void {
    for (const [key, turn] of turns) {
      if (clock.now() - turn.startedAt > STALE_TURN_MS) {
        if (turn.timer) clock.clearTimeout(turn.timer);
        turns.delete(key);
      }
    }
  }

  function turnOf(key: string): TurnStatus {
    let turn = turns.get(key);
    if (!turn) {
      sweep();
      turn = {
        batches: 0, chain: Promise.resolve(), closed: false, editGapMs: 0, lastSentAt: 0, messageId: null,
        rendered: "", startedAt: clock.now(), steps: [], timer: null, transport: null,
      };
      turns.set(key, turn);
    }
    return turn;
  }

  function schedule(turn: TurnStatus, delayMs: number): void {
    if (turn.timer || turn.closed) return;
    turn.timer = clock.setTimeout(() => {
      turn.timer = null;
      enqueueRender(turn);
    }, Math.max(0, delayMs));
  }

  function enqueueRender(turn: TurnStatus): void {
    turn.chain = turn.chain.then(async () => {
      if (turn.closed || !turn.transport || turn.steps.length === 0) return;
      const now = clock.now();
      const text = renderTelegramSteps(turn.steps);
      if (turn.messageId === null) {
        const wait = turn.startedAt + appearAfterMs - now;
        if (wait > 0) return schedule(turn, wait);
        turn.messageId = await turn.transport.send(text);
        // A status Telegram refused once is not retried on every step.
        if (turn.messageId === null) turn.closed = true;
        turn.lastSentAt = clock.now();
        turn.rendered = text;
        return;
      }
      if (text === turn.rendered) return;
      const wait = turn.lastSentAt + turn.editGapMs - now;
      if (wait > 0) return schedule(turn, wait);
      turn.rendered = text;
      turn.lastSentAt = now;
      await turn.transport.edit(turn.messageId, text);
    }).catch((error: unknown) => logFailure("AGENT_TELEGRAM_STEP_STATUS_FAILED", error));
  }

  return {
    /** The turn started now; its status may appear `appearAfterMs` later. */
    begin(key: string): void {
      turnOf(key);
    },
    record(
      key: string,
      actions: readonly TelegramStepAction[],
      transport: TelegramStepStatusTransport,
      editGapMs: number,
    ): void {
      const lines = actions.map(describeTelegramStep).filter((line): line is string => line !== null);
      if (lines.length === 0) return;
      const turn = turnOf(key);
      if (turn.closed) return;
      turn.batches += 1;
      for (const line of lines) turn.steps.push({ batch: turn.batches, line });
      turn.transport = transport;
      turn.editGapMs = editGapMs;
      enqueueRender(turn);
    },
    /** Ends the turn's status and deletes the message once any send in flight has finished. */
    async close(key: string): Promise<void> {
      const turn = turns.get(key);
      if (!turn) return;
      turns.delete(key);
      turn.closed = true;
      if (turn.timer) clock.clearTimeout(turn.timer);
      turn.timer = null;
      turn.chain = turn.chain.then(async () => {
        if (turn.messageId !== null && turn.transport) await turn.transport.remove(turn.messageId);
      }).catch((error: unknown) => logFailure("AGENT_TELEGRAM_STEP_STATUS_REMOVE_FAILED", error));
      let bound: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        turn.chain,
        new Promise<void>((resolve) => {
          bound = clock.setTimeout(resolve, CLOSE_WAIT_MS);
        }),
      ]);
      if (bound) clock.clearTimeout(bound);
    },
    size(): number {
      return turns.size;
    },
  };
}

export const telegramStepStatus = createTelegramStepStatus();
