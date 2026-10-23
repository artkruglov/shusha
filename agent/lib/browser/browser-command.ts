/**
 * The commands the `browser` tool may send to the logged-in browser, built by code from typed input.
 *
 * Exports:
 * - `BROWSER_ACTIONS`: the allowlist of actions the model can request.
 * - `BrowserAction`: one validated action.
 * - `parseBrowserAction`: input record to action, with a Russian correction on any invalid field.
 * - `browserCommandLine`: the bounded `agent-browser` shell line for an action that prints text.
 *
 * Key constructs:
 * - The logged-in Chrome now runs in the session's browser companion, apart from the model's Bash
 *   (runner target `browser`). The model reaches it only through these actions: navigation,
 *   snapshot, clicks and typing by element ref, text and address reads, a screenshot. Commands that
 *   hand out the session itself (`cookies`, `storage`, `state`, `eval`, `network`, `download`,
 *   `upload`, other sessions) have no action, so the family's logins never leave the browser.
 * - Every value goes through POSIX single quoting; the command name and flags are constants. A
 *   ref is `@e<number>` from the last snapshot, an address is http(s) without credentials.
 * - Each command is bounded by `timeout` inside the companion, below the runner's own limit, so a
 *   hung page reports `AGENT_BROWSER_TIMEOUT` instead of a runner failure.
 */
import { toolInputError } from "../tool-input-validation.js";

export const BROWSER_ACTIONS = [
  "open", "snapshot", "click", "fill", "type", "press", "select", "check", "hover",
  "scroll", "back", "forward", "reload", "read", "url", "title", "wait", "screenshot", "close",
] as const;
export type BrowserActionName = typeof BROWSER_ACTIONS[number];

export type BrowserAction =
  | { action: "open"; url: string }
  | { action: "snapshot" }
  | { action: "click"; label?: string; ref: string }
  | { action: "check" | "hover"; ref: string }
  | { action: "fill" | "type"; ref: string; text: string }
  | { action: "select"; ref: string; text: string }
  | { action: "press"; key: string }
  | { action: "scroll"; direction: "down" | "up" }
  | { action: "back" | "forward" | "reload" | "url" | "title" | "close" }
  | { action: "read"; ref?: string }
  | { action: "wait"; milliseconds: number }
  | { action: "screenshot"; fullPage: boolean };

const INPUT_ERROR_CODE = "AGENT_BROWSER_INPUT_INVALID";
export const BROWSER_CLI_TIMEOUT_SECONDS = 40;
const CLI_KILL_AFTER_SECONDS = 3;
const REF = /^@?e[0-9]{1,6}$/u;
const KEY = /^[A-Za-z0-9]+(?:\+[A-Za-z0-9]+){0,3}$/u;
const TEXT_MAX_CHARACTERS = 4_000;
const URL_MAX_CHARACTERS = 2_048;
const WAIT_MAX_MILLISECONDS = 10_000;

function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

function field(input: Record<string, unknown>, name: string, example: string): string {
  const value = input[name];
  if (typeof value !== "string" || value.length === 0) {
    toolInputError(INPUT_ERROR_CODE, `Для действия ${String(input.action)} нужно поле ${name}, например ${example}`);
  }
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) {
    toolInputError(INPUT_ERROR_CODE, `Поле ${name} содержит управляющие символы`);
  }
  return value;
}

function ref(input: Record<string, unknown>): string {
  const value = field(input, "ref", "\"@e12\" из последнего snapshot");
  if (!REF.test(value)) toolInputError(INPUT_ERROR_CODE, "ref берётся из последнего snapshot и выглядит как @e12");
  return value.startsWith("@") ? value : `@${value}`;
}

function text(input: Record<string, unknown>): string {
  const value = field(input, "text", "\"Москва\"");
  if (value.length > TEXT_MAX_CHARACTERS) toolInputError(INPUT_ERROR_CODE, `text длиннее ${TEXT_MAX_CHARACTERS} знаков`);
  return value;
}

function webAddress(input: Record<string, unknown>): string {
  const value = field(input, "url", "\"https://example.com\"");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    toolInputError(INPUT_ERROR_CODE, "url должен быть полным адресом https://…");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
    value.length > URL_MAX_CHARACTERS) {
    toolInputError(INPUT_ERROR_CODE, "url должен быть адресом http или https без логина и пароля в нём");
  }
  return parsed.toString();
}

export function parseBrowserAction(input: Record<string, unknown>): BrowserAction {
  const action = input.action;
  if (typeof action !== "string" || !(BROWSER_ACTIONS as readonly string[]).includes(action)) {
    toolInputError(INPUT_ERROR_CODE, `action должен быть одним из: ${BROWSER_ACTIONS.join(", ")}`);
  }
  switch (action as BrowserActionName) {
    case "open":
      return { action: "open", url: webAddress(input) };
    case "click": {
      const label = input.label;
      if (label !== undefined && (typeof label !== "string" || label.length > 300)) {
        toolInputError(INPUT_ERROR_CODE, "label это видимое имя кнопки из snapshot, до 300 знаков");
      }
      return { action: "click", ref: ref(input), ...(typeof label === "string" ? { label } : {}) };
    }
    case "check":
    case "hover":
      return { action: action as "check", ref: ref(input) };
    case "fill":
    case "type":
    case "select":
      return { action: action as "fill", ref: ref(input), text: text(input) };
    case "press": {
      const key = field(input, "key", "\"Enter\" или \"Control+a\"");
      if (!KEY.test(key)) toolInputError(INPUT_ERROR_CODE, "key это имя клавиши: Enter, Tab, Escape, ArrowDown, Control+a");
      return { action: "press", key };
    }
    case "scroll":
      return { action: "scroll", direction: input.direction === "up" ? "up" : "down" };
    case "read":
      return input.ref === undefined ? { action: "read" } : { action: "read", ref: ref(input) };
    case "wait": {
      const milliseconds = Number(input.milliseconds ?? 1_000);
      if (!Number.isInteger(milliseconds) || milliseconds < 100 || milliseconds > WAIT_MAX_MILLISECONDS) {
        toolInputError(INPUT_ERROR_CODE, `milliseconds от 100 до ${WAIT_MAX_MILLISECONDS}`);
      }
      return { action: "wait", milliseconds };
    }
    case "screenshot":
      return { action: "screenshot", fullPage: input.fullPage === true };
    default:
      return { action: action as "snapshot" };
  }
}

/** The `agent-browser` arguments of an action; quoting happens in `browserCommandLine`. */
function browserArguments(action: Exclude<BrowserAction, { action: "screenshot" }>): string[] {
  switch (action.action) {
    case "open": return ["open", action.url];
    // Interactive elements with refs, compact: what a click or a fill needs.
    case "snapshot": return ["snapshot", "-i", "-c"];
    case "click":
    case "check":
    case "hover": return [action.action, action.ref];
    case "fill":
    case "type":
    case "select": return [action.action, action.ref, action.text];
    case "press": return ["press", action.key];
    case "scroll": return ["scroll", action.direction];
    case "read": return ["get", "text", action.ref ?? "body"];
    case "url": return ["get", "url"];
    case "title": return ["get", "title"];
    case "wait": return ["wait", String(action.milliseconds)];
    default: return [action.action];
  }
}

function bounded(argumentsList: readonly string[]): string {
  const [name, ...rest] = argumentsList;
  return `/usr/bin/timeout --signal=TERM --kill-after=${CLI_KILL_AFTER_SECONDS}s ${BROWSER_CLI_TIMEOUT_SECONDS}s ` +
    `agent-browser ${[name, ...rest.map(shellQuote)].join(" ")}`;
}

export function browserCommandLine(action: Exclude<BrowserAction, { action: "screenshot" }>): string {
  return bounded(browserArguments(action));
}

/**
 * The companion has no workspace: it shoots into its own /tmp and prints the image as base64; the
 * bytes reach the workspace through the session's own container.
 */
export function browserScreenshotCommandLine(stagingPath: string, fullPage: boolean): string {
  const staging = shellQuote(stagingPath);
  const shot = bounded(fullPage ? ["screenshot", "--full", stagingPath] : ["screenshot", stagingPath]);
  return `${shot} >&2 && base64 -w0 ${staging}; status=$?; rm -f ${staging}; exit $status`;
}
