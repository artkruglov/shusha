/**
 * «Юля берёт: …» under the family group's morning overview after a «Беру» press.
 *
 * Exports:
 * - `claimLine`: one person's line for one taken task.
 * - `claimedMessageText`: the overview text with its taken lines, or null when there is nothing to add or
 *   the text would not fit in one Telegram message.
 *
 * The style guide edits the message in place («Юля взяла: Купить щёточку», `docs/design/style-guide.ru.md` §3.7).
 * Our unowned tasks stand under one overview message, so their lines are appended below it. Present tense
 * keeps the verb right without knowing anyone's gender. The lines come from the text already on screen and
 * from the database for the buttons of this keyboard: two quick presses each carry the text as it was before
 * either, and a button already taken is gone from the keyboard the next press sees.
 */
const MARKER = "✋ ";
/** A line names the task, it does not repeat it: a title may be 1000 characters. */
const LINE_TITLE_MAX = 60;
/** Bot API `editMessageText`: a longer text is refused, and the keyboard edit with it. */
const MESSAGE_MAX = 4096;

export function claimLine(name: string, title: string): string {
  const points = Array.from(title.replace(/\s+/gu, " ").trim());
  const short = points.length > LINE_TITLE_MAX ? `${points.slice(0, LINE_TITLE_MAX - 1).join("")}…` : points.join("");
  return `${MARKER}${name} берёт: ${short}`;
}

export function claimedMessageText(text: string, lines: readonly string[]): string | null {
  const start = text.indexOf(`\n\n${MARKER}`);
  const base = start === -1 ? text : text.slice(0, start);
  const shown = start === -1 ? [] : text.slice(start + 2).split("\n").filter((line) => line.startsWith(MARKER));
  const all = [...new Set([...shown, ...lines])];
  if (all.length === shown.length) return null;
  const edited = `${base}\n\n${all.join("\n")}`;
  // Too long to edit: the buttons are still redrawn, the lines are not written.
  return edited.length > MESSAGE_MAX ? null : edited;
}
