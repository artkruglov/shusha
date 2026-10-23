/**
 * Inline keyboards of task buttons: labels and the edit after a press.
 *
 * Exports:
 * - `InlineButton`, `InlineKeyboard`: the Bot API shapes this module reads and writes.
 * - `taskButtonLabel`: «✓ Купить хлеб» cut to what a phone shows in one button.
 * - `visibilityButtonLabel`: «👥 Сделать общим · …» or «🔒 Сделать личным · …».
 * - `groupButtonLabel`: «👥 В «Мама и Миша» · …» under a personal record.
 * - `resolvedKeyboard`: the message's keyboard with every task button as the database now says it is.
 * - `messageKeyboard`: the keyboard of the message a press came from, read from the raw update.
 *
 * The keyboard is edited in place: the pressed button turns into its reverse («✓ дело» into
 * «↩ Вернуть · дело» and back) or disappears, and every other button keeps its place, so nothing the
 * person is about to tap moves under the finger.
 */
export interface InlineButton {
  callback_data?: string;
  text: string;
  [key: string]: unknown;
}

export type InlineKeyboard = InlineButton[][];

/** A phone shows about this many characters in a full-width button before Telegram cuts it itself. */
const LABEL_MAX_CHARACTERS = 32;

/** Cut on code points: half of a surrogate pair would break the emoji people put in titles. */
export function taskButtonLabel(mark: string, title: string): string {
  const text = `${mark} ${title.replace(/\s+/gu, " ").trim()}`;
  const points = Array.from(text);
  return points.length <= LABEL_MAX_CHARACTERS ? text : `${points.slice(0, LABEL_MAX_CHARACTERS - 1).join("")}…`;
}

/** What a resolved task button is now, as `taskButtonRepository.resolve` returns it. */
export interface ButtonState {
  action: string;
  id: string;
  title: string | null;
  groupTitle?: string | null;
  repeat?: boolean;
}

/** `titled`: the button named its task (a receipt about several); a receipt about one says the action only. */
function labelOf(state: ButtonState, titled: boolean): string | null {
  if (state.title === null) return null;
  const title = titled ? state.title : null;
  if (state.action === "complete") return taskButtonLabel("✓", state.repeat ? `🔁 ${state.title}` : state.title);
  if (state.action === "reopen") return title === null ? "↩ Вернуть" : taskButtonLabel("↩", `Вернуть · ${title}`);
  if (state.action === "share" || state.action === "unshare") return visibilityButtonLabel(state.action, title);
  if (state.action === "to_group" && state.groupTitle) return groupButtonLabel(state.groupTitle, title);
  return null;
}

/**
 * «В «…»» under a personal record: the group's name first, it is what the person chooses. No 👥 or 🔒: the style
 * guide has four markers (§3.2), and the title only when the receipt is about several records (ревью 21 октября 2026:
 * one title cut on three buttons in a row).
 */
export function groupButtonLabel(group: string, title: string | null): string {
  return clip(title === null ? `В «${group}»` : `В «${group}» · ${title}`);
}

/** «Сделать общим» under a task only you see, «Сделать личным» under a shared one. */
export function visibilityButtonLabel(action: "share" | "unshare", title: string | null): string {
  const text = action === "share" ? "Сделать общим" : "Сделать личным";
  return clip(title === null ? text : `${text} · ${title}`);
}

function clip(text: string): string {
  const points = Array.from(text.replace(/\s+/gu, " ").trim());
  return points.length <= LABEL_MAX_CHARACTERS ? points.join("") : `${points.slice(0, LABEL_MAX_CHARACTERS - 1).join("")}…`;
}

/**
 * Every task button is redrawn from its current state, so two quick presses that each carried the old
 * keyboard cannot undo each other's change. A removed button goes with its emptied row; a button the
 * database does not know (expired) and any other button stay as they are.
 */
export function resolvedKeyboard(
  keyboard: InlineKeyboard,
  states: ReadonlyMap<string, ButtonState | null>,
  idOf: (data: string | undefined) => string | null,
  dataOf: (id: string) => string,
): InlineKeyboard {
  return keyboard
    .map((row) => row.flatMap((button) => {
      const id = idOf(button.callback_data);
      if (id === null || !states.has(id)) return [button];
      const state = states.get(id)!;
      if (state === null) return [];
      return [{ ...button, callback_data: dataOf(state.id), text: labelOf(state, button.text.includes(" · ") || button.text.startsWith("✓")) ?? button.text }];
    }))
    .filter((row) => row.length > 0);
}

function isButton(value: unknown): value is InlineButton {
  return typeof value === "object" && value !== null && typeof (value as { text?: unknown }).text === "string";
}

export function messageKeyboard(raw: Record<string, unknown>): InlineKeyboard | null {
  const message = raw.message;
  if (typeof message !== "object" || message === null) return null;
  const markup = (message as { reply_markup?: unknown }).reply_markup;
  if (typeof markup !== "object" || markup === null) return null;
  const rows = (markup as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(rows)) return null;
  const keyboard: InlineKeyboard = [];
  for (const row of rows) {
    if (!Array.isArray(row) || !row.every(isButton)) return null;
    keyboard.push(row.map((button) => ({ ...button })));
  }
  return keyboard;
}
