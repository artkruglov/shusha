/**
 * What a turn really closed, written by the code under the model's answer.
 *
 * Exports:
 * - `readTaskTurnReceipt`: tasks the person closed or cancelled in this chat's session since the turn began,
 *   with the ones a «↩ Вернуть» button may reopen.
 * - `formatTaskTurnReceipt`: the receipt line, or `null` when nothing changed.
 * - `appendTaskTurnReceipt`: the answer with the receipt below it.
 * - `receiptGoesAlone`: whether a silent turn still sends the receipt by itself (a reaction always does).
 * - `TaskTurnCreated`: a task the turn wrote in a private chat, with who sees it (onboarding v3).
 *
 * Key construct:
 * - Prod 12 October 2026: the model wrote «видео и выступление тоже считаю сделанными» without a single
 *   `complete`, and the person believed it. A sentence cannot be checked against the database without
 *   reading its meaning, so the model no longer lists what it closed: the code does, from committed rows
 *   only. An operation row ties a task to this Eve session (`<session>:<call>` keys, one session per chat),
 *   so a task closed in another chat at the same time never shows up here, and a task counts only if its
 *   version records the action since the turn began and it is still closed now.
 * - In a private chat the receipt also knows the tasks the turn wrote and who sees them. The answer already says it
 *   (`filed`, built by the code from the stored scope), so no line is added: a button under the answer changes it
 *   (`receipt-undo.ts`), and a person not asked yet gets the one-time default question. An idea and a tradition
 *   count too: a new idea is silently personal, a new tradition silently the family's, and the button is the only
 *   way to see and change that (`shared-task-visibility.ts` decides whether the change is allowed).
 */
import { database } from "./database.js";
import { cleanTaskTitle } from "./task-board.js";

export interface TaskTurnReceipt {
  readonly cancelled: readonly string[];
  readonly completed: readonly string[];
  /**
   * Tasks a «↩ Вернуть» button may reopen, at their current version. A repeated task is left out:
   * completing it moves it to its next date, and reopen does not move it back.
   */
  readonly undo: readonly TaskTurnUndo[];
  /** New tasks of a private turn; empty in a group, where everything written is the family's anyway. */
  readonly created: readonly TaskTurnCreated[];
  /** The person has not chosen who sees new tasks yet: the receipt asks once. */
  readonly askDefault: boolean;
}

export interface TaskTurnCreated {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly scope: "family" | "personal";
  /** Asked of another adult: shared by definition, so it gets no «Сделать личным». */
  readonly askedOther: boolean;
}

export interface TaskTurnUndo {
  readonly id: string;
  readonly title: string;
  readonly version: number;
}

const RECEIPT_TITLES_MAX = 12;

export async function readTaskTurnReceipt(input: {
  readonly eveSessionId: string;
  readonly familyId: string;
  readonly since: Date;
  readonly telegramUserId: string;
  readonly privateChat?: boolean;
}): Promise<TaskTurnReceipt> {
  const result = await database().query<{
    action: string; id: string; repeated: boolean; title: string; version: number;
  }>(
    `SELECT DISTINCT ON (t.id) v.action, t.id, t.title, t.version, t.recurrence_unit IS NOT NULL AS repeated
       FROM shared_task_operations o
       JOIN shared_task_versions v
         ON v.task_id = o.task_id AND v.actor_telegram_id = o.actor_telegram_id
        AND v.created_at >= $4 AND v.action IN ('complete', 'cancel')
       JOIN shared_tasks t ON t.id = o.task_id AND t.family_id = o.family_id
        AND t.status = CASE v.action WHEN 'complete' THEN 'completed' ELSE 'cancelled' END
      WHERE o.family_id = $1 AND o.actor_telegram_id = $3
        AND starts_with(o.operation_key, $2 || ':')
      ORDER BY t.id, v.created_at DESC`,
    [input.familyId, input.eveSessionId, input.telegramUserId, input.since],
  );
  const titles = (action: string) => result.rows.filter((row) => row.action === action).map((row) => row.title)
    .sort((a, b) => a.localeCompare(b, "ru"));
  const undo = result.rows.filter((row) => !row.repeated)
    .map((row) => ({ id: row.id, title: row.title, version: row.version }))
    .sort((a, b) => a.title.localeCompare(b.title, "ru"));
  if (!input.privateChat) return { askDefault: false, cancelled: titles("cancel"), completed: titles("complete"), created: [], undo };
  const created = await database().query<{
    assignee_telegram_id: string | null; id: string; scope: "family" | "personal"; title: string; version: number;
  }>(
    `SELECT DISTINCT t.id, t.title, t.version, t.scope, t.assignee_telegram_id
       FROM shared_task_operations o
       JOIN shared_tasks t ON t.id = o.task_id AND t.family_id = o.family_id
      WHERE o.family_id = $1 AND o.actor_telegram_id = $3 AND starts_with(o.operation_key, $2 || ':')
        AND t.creator_telegram_id = $3 AND t.created_at >= $4 AND t.scope IN ('personal', 'family')
        AND t.kind IN ('task', 'idea', 'ritual') AND t.status IN ('open', 'proposed', 'accepted')
      ORDER BY t.title`,
    [input.familyId, input.eveSessionId, input.telegramUserId, input.since],
  );
  const asked = await database().query<{ default_task_visibility: string | null }>(
    `SELECT settings.default_task_visibility FROM users person
       LEFT JOIN user_notification_settings settings ON settings.user_id = person.id
      WHERE person.telegram_user_id = $1`,
    [input.telegramUserId],
  );
  return {
    askDefault: created.rows.length > 0 && (asked.rows[0]?.default_task_visibility ?? null) === null,
    cancelled: titles("cancel"),
    completed: titles("complete"),
    created: created.rows.map((row) => ({
      askedOther: row.assignee_telegram_id !== input.telegramUserId, id: row.id, scope: row.scope, title: row.title,
      version: row.version,
    })),
    undo,
  };
}

export function formatTaskTurnReceipt(receipt: Pick<TaskTurnReceipt, "cancelled" | "completed">): string | null {
  const line = (mark: string, label: string, titles: readonly string[]) => {
    if (titles.length === 0) return null;
    const shown = titles.slice(0, RECEIPT_TITLES_MAX).map((title) => cleanTaskTitle(title, "rich"));
    const more = titles.length - shown.length;
    return `${mark} ${label}: ${shown.join("; ")}${more > 0 ? ` и ещё ${more}` : ""}`;
  };
  const lines = [line("✓", "Закрыто", receipt.completed), line("✗", "Отменено", receipt.cancelled)]
    .filter((text): text is string => text !== null);
  return lines.length === 0 ? null : lines.join("\n");
}

export function appendTaskTurnReceipt(message: string, receipt: TaskTurnReceipt): string {
  const formatted = formatTaskTurnReceipt(receipt);
  return formatted === null ? message : `${message}\n\n${formatted}`;
}

/**
 * A person's turn that closed tasks and then said nothing, or only reacted, still owes the receipt
 * (the family group reports «сделал» without addressing the agent). Text held to the turn's end is
 * the answer and carries the receipt itself; a scheduled run has no person who closed anything.
 */
export function receiptGoesAlone(turn: {
  readonly deliberateSilence: boolean;
  readonly scheduled: boolean;
  readonly textHeld: boolean;
}): boolean {
  return !turn.scheduled && turn.deliberateSilence && !turn.textHeld;
}
