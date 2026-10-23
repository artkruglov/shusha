/**
 * The morning overview after «✓»: the closed task's line reads «✓ ~~дело~~», in the same place.
 *
 * Exports:
 * - `struckOverview`: the overview text and entities with closed lines struck, or null when nothing changes.
 *   `tasks` go in the keyboard's order, which is the order of the overview's lines.
 *
 * Style guide §3.4: the title is struck through with Telegram's own formatting and gets «✓» instead of «•»;
 * lines and headers stay where they were. Both marks are one UTF-16 unit, so the offsets of the bold headers
 * do not move. What is closed comes from the database (the keyboard's buttons resolved: a «✓» that became
 * «↩ Вернуть» is closed), never from the update: two quick presses each carry the message as it was.
 */
import { cleanTaskTitle } from "../task-board.js";
import type { TelegramTextEntity } from "../memory-review/memory-review-owner-alert-transport.js";

const OPEN = "• ";
const CLOSED = "✓ ";
const REPEAT = "🔁 ";
const DUE_SEPARATOR = " — ";

/** Where the task's name sits in an overview line, when the line is about this title. */
function nameSpan(line: string, title: string): { end: number; start: number } | null {
  if (!line.startsWith(OPEN) && !line.startsWith(CLOSED)) return null;
  const start = line.slice(2).startsWith(REPEAT) ? 2 + REPEAT.length : 2;
  const rest = line.slice(start);
  const name = cleanTaskTitle(title, "plain");
  if (rest !== name && !rest.startsWith(`${name}${DUE_SEPARATOR}`)) return null;
  return { end: start + name.length, start };
}

export function struckOverview(
  text: string,
  entities: readonly TelegramTextEntity[],
  tasks: ReadonlyArray<{ closed: boolean; title: string }>,
): { entities: TelegramTextEntity[]; text: string } | null {
  const kept = entities.filter((entity) => entity.type !== "strikethrough");
  const struck: TelegramTextEntity[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let changed = false;
  const used = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    // Lines follow the buttons' order: the k-th «Купить хлеб» line is the k-th «Купить хлеб» button.
    const position = tasks.findIndex((candidate, at) => !used.has(at) && nameSpan(line, candidate.title) !== null);
    const task = position === -1 ? undefined : tasks[position];
    if (task) {
      used.add(position);
      const mark = task.closed ? CLOSED : OPEN;
      if (!line.startsWith(mark)) {
        lines[index] = mark + line.slice(2);
        changed = true;
      }
      if (task.closed) {
        const span = nameSpan(lines[index]!, task.title)!;
        struck.push({ length: span.end - span.start, offset: offset + span.start, type: "strikethrough" });
      }
    }
    offset += lines[index]!.length + 1;
  }
  const before = entities.filter((entity) => entity.type === "strikethrough");
  const same = before.length === struck.length &&
    before.every((entity, index) => entity.offset === struck[index]!.offset && entity.length === struck[index]!.length);
  if (!changed && same) return null;
  return { entities: [...kept, ...struck].sort((a, b) => a.offset - b.offset), text: lines.join("\n") };
}
