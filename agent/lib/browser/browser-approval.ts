/**
 * The confirmation step of the `browser` tool: decided before the call and checked again in it.
 *
 * Exports:
 * - `BrowserPageReader`: how the gate reads the live page (a snapshot and the address).
 * - `resolveBrowserGate`: the gate of one action on the page as it is now.
 * - `browserApprovalDecision`: the Eve approval answer for a call.
 * - `browserApprovalFacts`: what the confirmation window shows, read from the page, not the model.
 * - `browserLabelMismatch`: why a gated click with a wrong `label` is refused.
 *
 * Key constructs:
 * - A gated click must carry `label`, the element's visible name. The approval, the window and the
 *   execution all compare it with the live page; the label is part of the approved input, so the
 *   page cannot swap «Оплатить 500 ₽» for «Оплатить 5 000 ₽» between the button and the click.
 * - A page that cannot be read asks for confirmation instead of waving the action through.
 */
import { type BrowserAction } from "./browser-command.js";
import {
  browserGate,
  type BrowserGateReason,
  GATE_REASON_TEXT,
  parseSnapshotElements,
  type SnapshotElement,
} from "./browser-gate.js";

export interface BrowserPageReader {
  snapshot(): Promise<string>;
  url(): Promise<string>;
}

export type BrowserGateResult =
  | { gated: false }
  | { element?: SnapshotElement; gated: true; reason: BrowserGateReason };

export async function resolveBrowserGate(input: {
  action: BrowserAction;
  entered: boolean;
  page: BrowserPageReader;
}): Promise<BrowserGateResult> {
  const { action } = input;
  if (action.action === "press") return browserGate({ action: "press", entered: input.entered, key: action.key });
  if (action.action !== "click") return { gated: false };
  const element = parseSnapshotElements(await input.page.snapshot()).get(action.ref);
  const decision = browserGate({ action: "click", element, entered: input.entered });
  return decision.gated ? { ...decision, ...(element ? { element } : {}) } : decision;
}

export function browserLabelMismatch(action: BrowserAction, gate: BrowserGateResult): string | null {
  if (!gate.gated || action.action !== "click" || !gate.element) return null;
  if (action.label === gate.element.name) return null;
  return `AGENT_BROWSER_LABEL_REQUIRED: Это действие требует подтверждения человека. Повтори вызов с label, ` +
    `точно равным имени элемента на странице: ${JSON.stringify(gate.element.name)}`;
}

export async function browserApprovalDecision(input: {
  action: BrowserAction;
  entered: boolean;
  page: BrowserPageReader;
}): Promise<"not-applicable" | "user-approval" | { reason: string; type: "denied" }> {
  if (input.action.action !== "click" && input.action.action !== "press") return "not-applicable";
  let gate: BrowserGateResult;
  try {
    gate = await resolveBrowserGate(input);
  } catch {
    return "user-approval";
  }
  if (!gate.gated) return "not-applicable";
  const mismatch = browserLabelMismatch(input.action, gate);
  return mismatch ? { reason: mismatch, type: "denied" } : "user-approval";
}

export async function browserApprovalFacts(input: {
  action: BrowserAction;
  entered: boolean;
  page: BrowserPageReader;
}): Promise<Array<[string, string]>> {
  let site = "не удалось прочитать";
  try {
    site = new URL((await input.page.url()).trim()).host;
  } catch { /* the window still names the element and the reason */ }
  let gate: BrowserGateResult | null = null;
  try {
    gate = await resolveBrowserGate(input);
  } catch { /* unknown page: the reason says so */ }
  const target = input.action.action === "press"
    ? `клавиша ${input.action.key}`
    : gate?.gated && gate.element ? `«${gate.element.name}»` : input.action.action === "click" && input.action.label
      ? `«${input.action.label}»`
      : "элемент страницы";
  const reason = gate?.gated ? GATE_REASON_TEXT[gate.reason] : "страницу не удалось проверить, поэтому спрашиваю";
  return [["Сайт", site], ["Нажать", target], ["Почему спрашиваю", reason]];
}
