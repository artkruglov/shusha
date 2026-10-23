/**
 * Server directives at the end of a guest answer: what the chat asked to remember, mark done,
 * forget, or be reminded of.
 *
 * Exports:
 * - `GuestAction`: one validated change to the chat's notes or one reminder offer.
 * - `parseGuestDirectives`: the visible text without directives, and the actions they carry.
 *
 * The model writes directives; the code decides what they may do. The chat they apply to comes from
 * the Telegram update, never from the text. A note number refers to the numbered list the prompt
 * showed in this same answer. A malformed or out-of-range directive is dropped and logged, never
 * shown to the people in the chat. Moscow has had no daylight saving since 2014, so its wall clock
 * is a fixed +03:00 offset.
 */
const MAX_CONTENT_CHARACTERS = 500;
const MAX_NOTES_PER_ANSWER = 5;
const MAX_REMINDER_AHEAD_MS = 366 * 86_400_000;
const MOSCOW_OFFSET = "+03:00";
const MOSCOW_OFFSET_MS = 3 * 3_600_000;

export type GuestAction =
  | { readonly content: string; readonly dueOn: string | null; readonly type: "remember" }
  | { readonly number: number; readonly type: "done" | "forget" }
  | { readonly type: "forget_all" }
  | { readonly content: string; readonly runAt: Date; readonly type: "reminder" };

export interface GuestDirectives {
  readonly actions: readonly GuestAction[];
  readonly dropped: number;
  readonly text: string;
}

// Models slip on the small things: single quotes, a missing `/`, a closing tag after a mark, capitals.
// Those still count; anything else that looks like a directive is stripped and reported as dropped.
const DIRECTIVE = /<guest-(remember|reminder)\b([^>]*)>([\s\S]*?)<\/guest-\1\s*>|<guest-(forget-all|done|forget)(?![\w-])([^>]*?)\/?>(?:\s*<\/guest-\4\s*>)?/giu;
// A tag the pattern above did not accept must still never reach the chat.
const LEFTOVER = /<\/?guest-[^>]*>/giu;

function attribute(attributes: string | undefined, name: string): string | undefined {
  const match = attributes?.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'/>]+))`, "iu"));
  return match ? (match[1] ?? match[2] ?? match[3])?.trim() : undefined;
}

function content(raw: string): string | null {
  // A directive inside a note would be stored as its text and shown back to the model later.
  if (/<\/?guest-/iu.test(raw)) return null;
  const value = raw.replace(/\s+/gu, " ").trim();
  return value.length > 0 && value.length <= MAX_CONTENT_CHARACTERS ? value : null;
}

function dueOn(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(raw)) return undefined;
  const date = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? undefined : raw;
}

function runAt(raw: string | undefined, now: Date): Date | null {
  const match = raw?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/u);
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}:00${MOSCOW_OFFSET}`);
  if (Number.isNaN(date.getTime())) return null;
  // `Date` rolls 30 February into March and 24:00 into the next day; a slip like that is not the time asked for.
  const moscow = new Date(date.getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 16);
  if (moscow !== `${match[1]}T${match[2]}`) return null;
  const ahead = date.getTime() - now.getTime();
  return ahead > 0 && ahead <= MAX_REMINDER_AHEAD_MS ? date : null;
}

export function parseGuestDirectives(answer: string, now: Date): GuestDirectives {
  const actions: GuestAction[] = [];
  let dropped = 0;
  let notes = 0;
  let reminders = 0;
  const text = answer.replace(DIRECTIVE, (_tag, pairedKind, attributes, body, singleKind, singleAttributes) => {
    const kind = String(pairedKind ?? singleKind).toLowerCase();
    if (kind === "remember") {
      const note = content(body);
      const due = attribute(attributes, "at") === undefined ? dueOn(attribute(attributes, "due")) : undefined;
      if (note && due !== undefined && notes < MAX_NOTES_PER_ANSWER) {
        notes += 1;
        actions.push({ content: note, dueOn: due, type: "remember" });
      } else dropped += 1;
    } else if (kind === "reminder") {
      const what = content(body);
      const when = runAt(attribute(attributes, "at"), now);
      if (what && when && reminders === 0) {
        reminders += 1;
        actions.push({ content: what, runAt: when, type: "reminder" });
      } else dropped += 1;
    } else if (kind === "done" || kind === "forget") {
      const n = Number(attribute(singleAttributes, "n"));
      if (Number.isSafeInteger(n) && n >= 1 && n <= 999) actions.push({ number: n, type: kind });
      else dropped += 1;
    } else {
      actions.push({ type: "forget_all" });
    }
    return "";
  });
  const leftovers = text.match(LEFTOVER)?.length ?? 0;
  return {
    actions,
    dropped: dropped + leftovers,
    text: text.replace(LEFTOVER, "").replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim(),
  };
}
