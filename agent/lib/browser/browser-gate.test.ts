/**
 * The browser gate: which clicks and keys wait for a person.
 *
 * Constructs covered:
 * - Snapshot lines of agent-browser 0.36 parse into refs with role and name (real output of a form).
 * - Transaction words always stop; booking and "continue" words stop on a button; after typed
 *   data any click on a button or link and any Enter stop; a search box is not typed data; a cookie
 *   banner and tabs after typing do not stop.
 * - A gated click needs `label` equal to the live element name; an unreadable page asks.
 * - The confirmation window names the site, the element and the reason from the page.
 */
import { describe, expect, it } from "vitest";

import { browserApprovalDecision, browserApprovalFacts } from "./browser-approval.js";
import { browserGate, createEnteredDataRegistry, isDataEntryTarget, parseSnapshotElements } from "./browser-gate.js";

// Captured on production 8 October 2026 from https://httpbin.org/forms/post.
const FORM_SNAPSHOT = [
  "- textbox \"Customer name: \" [ref=e2]",
  "- radio \" Small\" [checked=false, ref=e5]",
  "- spinbutton \"Hours Hours\" [ref=e14]: 0",
  "- button \"Show time picker\" [ref=e13]",
  "- searchbox \"Поиск по сайту\" [ref=e20]",
  "- link \"Принять cookies\" [ref=e21]",
  "- tab \"Доставка\" [ref=e22]",
  "- link \"Далее\" [ref=e23]",
  "- button \"Submit order\" [ref=e1]",
].join("\n");

describe("parseSnapshotElements", () => {
  it("reads role and name by ref, attributes and values included", () => {
    const elements = parseSnapshotElements(FORM_SNAPSHOT);
    expect(elements.get("@e1")).toEqual({ name: "Submit order", role: "button" });
    expect(elements.get("@e5")).toEqual({ name: "Small", role: "radio" });
    expect(elements.get("@e14")).toEqual({ name: "Hours Hours", role: "spinbutton" });
  });
});

describe("browserGate", () => {
  const elements = parseSnapshotElements(FORM_SNAPSHOT);
  const click = (ref: string, entered = false) => browserGate({ action: "click", element: elements.get(ref), entered });

  it("stops transaction words always and booking words on a button", () => {
    expect(click("@e1")).toEqual({ gated: true, reason: "transaction" });
    expect(browserGate({ action: "click", element: { name: "Оплатить 500 ₽", role: "button" }, entered: false })).toMatchObject({ gated: true });
    expect(browserGate({ action: "click", element: { name: "Записаться", role: "button" }, entered: false })).toEqual({ gated: true, reason: "form-submit" });
    // A «Далее» link on a page without typed data only leads on.
    expect(click("@e23")).toEqual({ gated: false });
    expect(click("@e23", true)).toEqual({ gated: true, reason: "form-submit" });
    expect(click("@e13")).toEqual({ gated: false });
  });

  it("after typed data stops buttons and Enter, not tabs or a cookie banner", () => {
    expect(click("@e13", true)).toEqual({ gated: true, reason: "after-entry" });
    expect(click("@e22", true)).toEqual({ gated: false });
    expect(click("@e21", true)).toEqual({ gated: false });
    expect(browserGate({ action: "press", entered: true, key: "Enter" })).toEqual({ gated: true, reason: "after-entry" });
    expect(browserGate({ action: "press", entered: true, key: "Control+Enter" })).toMatchObject({ gated: true });
    expect(browserGate({ action: "press", entered: false, key: "Enter" })).toEqual({ gated: false });
    expect(browserGate({ action: "press", entered: true, key: "Tab" })).toEqual({ gated: false });
    // An element the snapshot does not name stops once data was typed.
    expect(browserGate({ action: "click", entered: true })).toEqual({ gated: true, reason: "after-entry" });
  });

  it("does not count a search box as typed data and forgets it on a new page", () => {
    expect(isDataEntryTarget(elements.get("@e20"))).toBe(false);
    expect(isDataEntryTarget(elements.get("@e2"))).toBe(true);
    const registry = createEnteredDataRegistry();
    registry.mark("s1");
    expect(registry.has("s1")).toBe(true);
    registry.clear("s1");
    expect(registry.has("s1")).toBe(false);
  });
});

describe("browser approval", () => {
  const page = { snapshot: async () => FORM_SNAPSHOT, url: async () => "https://httpbin.org/forms/post?token=1\n" };

  it("asks only for gated actions and only with the exact label", async () => {
    await expect(browserApprovalDecision({ action: { action: "click", ref: "@e13" }, entered: false, page })).resolves.toBe("not-applicable");
    await expect(browserApprovalDecision({ action: { action: "snapshot" }, entered: true, page })).resolves.toBe("not-applicable");
    await expect(browserApprovalDecision({ action: { action: "click", label: "Submit order", ref: "@e1" }, entered: false, page })).resolves.toBe("user-approval");
    const denied = await browserApprovalDecision({ action: { action: "click", label: "Show", ref: "@e1" }, entered: false, page });
    expect(denied).toMatchObject({ reason: expect.stringContaining("\"Submit order\""), type: "denied" });
  });

  it("asks when the page cannot be read", async () => {
    const broken = { snapshot: async () => { throw new Error("down"); }, url: async () => "" };
    await expect(browserApprovalDecision({ action: { action: "click", ref: "@e1" }, entered: false, page: broken })).resolves.toBe("user-approval");
  });

  it("names the site, the element and the reason from the page", async () => {
    await expect(browserApprovalFacts({ action: { action: "click", label: "Submit order", ref: "@e1" }, entered: false, page })).resolves.toEqual([
      ["Сайт", "httpbin.org"],
      ["Нажать", "«Submit order»"],
      ["Почему спрашиваю", expect.stringContaining("оплаты, заказа")],
    ]);
  });
});
