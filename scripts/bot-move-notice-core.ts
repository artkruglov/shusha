/**
 * One message to every family member from the old bot before the installation moves to a new one
 * (Шуша → Юна, `docs/service/pm/bot-name-and-username.md`, «Вечер переезда», step 1).
 *
 * Exports:
 * - `BotMoveNoticeDependencies`: recipients, the Telegram send and the log of who already got it.
 * - `runBotMoveNotice`: a dry run by default; with `send` delivers once per person and reports counts.
 *
 * Without the move notice a person who never opens the new bot silently loses reminders and the overview,
 * so every member gets it, at most once: the log of sent ids makes a repeated run skip them. A person who
 * blocked the old bot (403) is logged too and never retried. Nothing is written to the database.
 */

export interface BotMoveNoticeDependencies {
  recipients(): Promise<readonly string[]>;
  /** Resolves to "sent", "blocked" (Telegram 403) or throws on any other failure. */
  send(chatId: string, text: string): Promise<"sent" | "blocked">;
  alreadyNotified(): Promise<ReadonlySet<string>>;
  record(chatId: string, outcome: "sent" | "blocked"): Promise<void>;
  pause(ms: number): Promise<void>;
}

export interface BotMoveNoticeResult {
  readonly recipients: number;
  readonly skipped: number;
  readonly sent: number;
  readonly blocked: number;
  readonly failed: number;
}

/** Telegram allows about 30 messages a second to different chats; one per 100 ms stays far below. */
const SEND_INTERVAL_MS = 100;

export async function runBotMoveNotice(
  input: { newUsername: string; send: boolean; text: string },
  dependencies: BotMoveNoticeDependencies,
): Promise<BotMoveNoticeResult> {
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(input.newUsername)) {
    throw new Error("AGENT_BOT_MOVE_USERNAME_INVALID: Новый username бота задан неверно");
  }
  // The whole point of the message is the link: a text without it would strand everyone it reaches.
  if (!input.text.includes(`t.me/${input.newUsername}`)) {
    throw new Error("AGENT_BOT_MOVE_LINK_MISSING: В тексте нет ссылки на нового бота");
  }
  const recipients = [...new Set(await dependencies.recipients())];
  const done = await dependencies.alreadyNotified();
  const pending = recipients.filter((chatId) => !done.has(chatId));
  const result = { blocked: 0, failed: 0, recipients: recipients.length, sent: 0, skipped: recipients.length - pending.length };
  if (!input.send) return result;
  for (const chatId of pending) {
    try {
      const outcome = await dependencies.send(chatId, input.text);
      await dependencies.record(chatId, outcome);
      result[outcome] += 1;
    } catch {
      // Not logged: the next run tries this person again.
      result.failed += 1;
    }
    await dependencies.pause(SEND_INTERVAL_MS);
  }
  return result;
}
