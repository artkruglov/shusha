/**
 * Which browser actions wait for a person's confirmation, decided by code from the live page.
 *
 * Exports:
 * - `parseSnapshotElements`: refs of an `agent-browser snapshot` with their role and name.
 * - `browserGate`: `{ gated, reason }` for one action on one element.
 * - `GATE_REASON_TEXT`: what the confirmation window says about each reason.
 * - `isDataEntryTarget`: whether a fill counts as data entered into a form.
 * - `createEnteredDataRegistry`: per browser session, whether data was typed since the last open.
 *
 * Key constructs (rules from ilkruglov gate.ts and irreversible.ts, on agent-browser refs):
 * - No model decides whether an action is final. A transaction word on a clickable element (pay,
 *   order, send, confirm, delete, buy) always stops; a booking or "continue" word stops on a button,
 *   or on a link once data was typed; after typed data any click on a button or link and any Enter
 *   stop, except a cookie banner and tabs. A false stop costs one confirmation.
 * - A search box is a way around a site, not a form: typing there is not entered data.
 * - The registry lives in the agent process: after a restart a form typed before it is not known,
 *   so a click there stops only by its words. That is the known gap of this minimal gate.
 */
export interface SnapshotElement { name: string; role: string; }
export type BrowserGateReason = "after-entry" | "form-submit" | "transaction";

const TRANSACTION_WORDS = [
  "подтвердить", "подтверждаю", "оплатить", "оплата", "отправить", "заказать", "оформить", "купить", "удалить",
  "перевести", "списать", "confirm", "pay", "submit", "order", "checkout", "buy", "delete", "send", "purchase",
];
const FORM_SUBMIT_WORDS = [
  "записаться", "записать", "сохранить", "забронировать", "бронировать", "продолжить", "далее", "готово",
  "войти", "зарегистрироваться", "book", "reserve", "continue", "next", "sign in", "log in", "register",
];
const words = (list: readonly string[]) => new RegExp(`(?:^|[^\\p{L}])(?:${list.join("|")})(?:[^\\p{L}]|$)`, "iu");
const TRANSACTION = words(TRANSACTION_WORDS);
const FORM_SUBMIT = words(FORM_SUBMIT_WORDS);
const CLICKABLE_ROLES = new Set(["button", "link", "menuitem", "menuitemcheckbox", "generic", "img", "cell", "listitem"]);
const SAFE_AFTER_ENTRY_ROLES = new Set(["tab", "option", "treeitem", "radio", "checkbox", "combobox", "textbox", "searchbox", "spinbutton"]);
const COOKIE_CONSENT = /cookie|куки/iu;
const SEARCH_FIELD = /поиск|найти|search/iu;
const ELEMENT_LINE = /^\s*-\s+([a-z]+)\s+"((?:[^"\\]|\\.)*)"[^[\n]*\[([^\]\n]*)\]/u;

export const GATE_REASON_TEXT: Readonly<Record<BrowserGateReason, string>> = {
  "after-entry": "после ввода данных на этой странице любое нажатие может отправить форму",
  "form-submit": "кнопка записи, бронирования, входа или перехода к следующему шагу",
  transaction: "кнопка оплаты, заказа, отправки, подтверждения или удаления",
};

export function parseSnapshotElements(snapshot: string): Map<string, SnapshotElement> {
  const elements = new Map<string, SnapshotElement>();
  for (const line of snapshot.split("\n")) {
    const match = ELEMENT_LINE.exec(line);
    const ref = match?.[3]?.match(/(?:^|,\s*)ref=(e[0-9]+)/u)?.[1];
    if (!match || !ref) continue;
    elements.set(`@${ref}`, { name: match[2]!.replace(/\\(.)/gu, "$1").replace(/\s+/gu, " ").trim(), role: match[1]! });
  }
  return elements;
}

export function isDataEntryTarget(element: SnapshotElement | undefined): boolean {
  if (!element) return true;
  return element.role !== "searchbox" && !SEARCH_FIELD.test(element.name);
}

export function browserGate(input: {
  action: "click" | "press";
  element?: SnapshotElement;
  entered: boolean;
  key?: string;
}): { gated: false } | { gated: true; reason: BrowserGateReason } {
  if (input.action === "press") {
    const enter = (input.key ?? "").split("+").some((part) => part.toLowerCase() === "enter");
    return enter && input.entered ? { gated: true, reason: "after-entry" } : { gated: false };
  }
  const element = input.element;
  // An element the snapshot does not name cannot be judged: the click stops, it is not waved through.
  if (!element) return input.entered ? { gated: true, reason: "after-entry" } : { gated: false };
  if (TRANSACTION.test(element.name) && CLICKABLE_ROLES.has(element.role)) return { gated: true, reason: "transaction" };
  if (FORM_SUBMIT.test(element.name) && (element.role === "button" || (input.entered && CLICKABLE_ROLES.has(element.role)))) {
    return { gated: true, reason: "form-submit" };
  }
  if (input.entered && COOKIE_CONSENT.test(element.name)) return { gated: false };
  if (input.entered && !SAFE_AFTER_ENTRY_ROLES.has(element.role)) return { gated: true, reason: "after-entry" };
  return { gated: false };
}

const MAX_TRACKED_SESSIONS = 2_000;

export function createEnteredDataRegistry() {
  const entered = new Set<string>();
  return {
    clear(sessionId: string) { entered.delete(sessionId); },
    has(sessionId: string) { return entered.has(sessionId); },
    mark(sessionId: string) {
      entered.delete(sessionId);
      entered.add(sessionId);
      while (entered.size > MAX_TRACKED_SESSIONS) entered.delete(entered.values().next().value!);
    },
  };
}
export const browserEnteredData = createEnteredDataRegistry();
