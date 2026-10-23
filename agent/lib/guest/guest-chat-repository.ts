/**
 * Notes, tasks and reminder offers of a chat the bot was summoned into as a guest (migration 174).
 *
 * Exports:
 * - `GuestChatNote`: one note as the prompt numbers it.
 * - `GuestReminderOffer`: what a «Напомнить и мне» press turns into a personal reminder.
 * - `guestChatRepository`: read on summon, apply an answer's actions in one transaction, read an
 *   offer for a press, and purge chats not summoned for 90 days.
 *
 * The chat key comes only from the verified guest update (`GuestMessage.chatKey`). Note numbers are
 * positions in the list the prompt showed; `apply` resolves them against the same list, so a number
 * never reaches a note of another chat. The list holds the newest notes: an old note past the limit is
 * no longer shown, and a new one always is.
 */
import { database } from "../database.js";
import type { GuestAction } from "./guest-directives.js";

/** Owner decision of 12 October 2026: a chat forgotten for three months is deleted. */
export const GUEST_CHAT_RETENTION_DAYS = 90;
const GUEST_NOTES_SHOWN = 40;
const DONE_NOTES_SHOWN_DAYS = 7;
const OFFER_GRACE_DAYS = 1;

export interface GuestChatNote {
  readonly content: string;
  readonly done: boolean;
  readonly dueOn: string | null;
  readonly id: string;
}

export interface GuestReminderOffer {
  readonly content: string;
  readonly id: string;
  readonly runAt: Date;
}

export interface GuestAppliedActions {
  readonly offerId: string | null;
  readonly skipped: number;
}

export const guestChatRepository = {
  /** Marks the chat as summoned and returns its open notes and recently done ones, oldest first. */
  async summon(chatKey: string): Promise<GuestChatNote[]> {
    await database().query(
      `INSERT INTO telegram_guest_chats (chat_key) VALUES ($1)
       ON CONFLICT (chat_key) DO UPDATE SET last_summoned_at = now()`,
      [chatKey],
    );
    const result = await database().query<{ content: string; done: boolean; due_on: string | null; id: string }>(
      `SELECT id, content, to_char(due_on, 'YYYY-MM-DD') AS due_on, done_at IS NOT NULL AS done
         FROM telegram_guest_chat_notes
        WHERE chat_key = $1
          AND (done_at IS NULL OR done_at > now() - $2::integer * interval '1 day')
        ORDER BY created_at DESC, id DESC
        LIMIT $3::integer`,
      [chatKey, DONE_NOTES_SHOWN_DAYS, GUEST_NOTES_SHOWN],
    );
    return result.rows.reverse().map((row) => ({ content: row.content, done: row.done, dueOn: row.due_on, id: row.id }));
  },

  async apply(input: {
    actions: readonly GuestAction[];
    authorTelegramUserId: string;
    chatKey: string;
    shown: readonly GuestChatNote[];
  }): Promise<GuestAppliedActions> {
    if (input.actions.length === 0) return { offerId: null, skipped: 0 };
    const client = await database().connect();
    let offerId: string | null = null;
    let skipped = 0;
    try {
      await client.query("BEGIN");
      for (const action of input.actions) {
        if (action.type === "remember") {
          await client.query(
            // `now()` is one instant per transaction; list numbers need the order the notes were written in.
            `INSERT INTO telegram_guest_chat_notes
               (chat_key, content, due_on, author_telegram_user_id, created_at)
             VALUES ($1, $2, $3::date, $4::bigint, clock_timestamp())`,
            [input.chatKey, action.content, action.dueOn, input.authorTelegramUserId],
          );
        } else if (action.type === "done" || action.type === "forget") {
          const note = input.shown[action.number - 1];
          if (!note) {
            skipped += 1;
            continue;
          }
          await client.query(
            action.type === "done"
              ? "UPDATE telegram_guest_chat_notes SET done_at = now() WHERE id = $1 AND chat_key = $2"
              : "DELETE FROM telegram_guest_chat_notes WHERE id = $1 AND chat_key = $2",
            [note.id, input.chatKey],
          );
        } else if (action.type === "forget_all") {
          await client.query("DELETE FROM telegram_guest_chat_notes WHERE chat_key = $1", [input.chatKey]);
          await client.query("DELETE FROM telegram_guest_reminder_offers WHERE chat_key = $1", [input.chatKey]);
        } else if (action.type === "reminder") {
          const offer = await client.query<{ id: string }>(
            `INSERT INTO telegram_guest_reminder_offers (chat_key, content, run_at, author_telegram_user_id)
             VALUES ($1, $2, $3, $4::bigint) RETURNING id`,
            [input.chatKey, action.content, action.runAt, input.authorTelegramUserId],
          );
          offerId = offer.rows[0]!.id;
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { offerId, skipped };
  },

  /** An offer whose time has not come; a passed or forgotten one is gone. */
  async findOffer(offerId: string): Promise<GuestReminderOffer | null> {
    const result = await database().query<{ content: string; id: string; run_at: Date }>(
      `SELECT id, content, run_at FROM telegram_guest_reminder_offers
        WHERE id = $1 AND run_at > now()`,
      [offerId],
    );
    const row = result.rows[0];
    return row ? { content: row.content, id: row.id, runAt: row.run_at } : null;
  },

  async purgeExpired(now: Date): Promise<number> {
    const chats = await database().query(
      `DELETE FROM telegram_guest_chats
        WHERE last_summoned_at <= $1::timestamptz - $2::integer * interval '1 day'`,
      [now, GUEST_CHAT_RETENTION_DAYS],
    );
    await database().query(
      `DELETE FROM telegram_guest_reminder_offers
        WHERE run_at <= $1::timestamptz - $2::integer * interval '1 day'`,
      [now, OFFER_GRACE_DAYS],
    );
    return chats.rowCount ?? 0;
  },
};
