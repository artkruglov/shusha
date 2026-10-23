/**
 * Browser tool commands and their execution.
 *
 * Constructs covered:
 * - Only allowlisted actions exist; nothing hands out cookies, storage, state or script eval.
 * - Values are single-quoted, refs and keys are validated, addresses are http(s) without credentials.
 * - Every command is bounded by an absolute `timeout` and runs with runner target `browser`.
 * - A screenshot is written into `shots/` of the chat's workspace through the session container.
 * - A timeout is `AGENT_BROWSER_TIMEOUT`, other failures `AGENT_BROWSER_FAILED` without query strings.
 */
import { describe, expect, it, vi } from "vitest";

import { BROWSER_ACTIONS, browserCommandLine, browserScreenshotCommandLine, parseBrowserAction } from "./browser-command.js";
import { runBrowserAction } from "./browser-session.js";

describe("parseBrowserAction", () => {
  it("has no action that hands out the logged-in session", () => {
    for (const forbidden of ["cookies", "storage", "state", "eval", "network", "download", "upload", "session", "auth"]) {
      expect(BROWSER_ACTIONS as readonly string[]).not.toContain(forbidden);
      expect(() => parseBrowserAction({ action: forbidden })).toThrow("AGENT_BROWSER_INPUT_INVALID");
    }
  });

  it("validates refs, keys and addresses", () => {
    expect(parseBrowserAction({ action: "click", ref: "e12" })).toEqual({ action: "click", ref: "@e12" });
    expect(() => parseBrowserAction({ action: "click", ref: "@e1; cookies" })).toThrow("AGENT_BROWSER_INPUT_INVALID");
    expect(() => parseBrowserAction({ action: "press", key: "Enter && cookies" })).toThrow("AGENT_BROWSER_INPUT_INVALID");
    expect(parseBrowserAction({ action: "press", key: "Control+a" })).toEqual({ action: "press", key: "Control+a" });
    expect(() => parseBrowserAction({ action: "open", url: "file:///etc/passwd" })).toThrow("AGENT_BROWSER_INPUT_INVALID");
    expect(() => parseBrowserAction({ action: "open", url: "https://user:pw@example.com" })).toThrow("AGENT_BROWSER_INPUT_INVALID");
    expect(() => parseBrowserAction({ action: "fill", ref: "@e3" })).toThrow("AGENT_BROWSER_INPUT_INVALID");
  });

  it("quotes every value and bounds the command with the system timeout", () => {
    const line = browserCommandLine(parseBrowserAction({ action: "fill", ref: "@e3", text: "O'Hara $(id) `x`" }) as never);
    expect(line).toBe(
      "/usr/bin/timeout --signal=TERM --kill-after=3s 40s agent-browser fill '@e3' 'O'\\''Hara $(id) `x`'",
    );
    expect(browserCommandLine({ action: "snapshot" })).toContain("agent-browser snapshot '-i' '-c'");
    expect(browserCommandLine({ action: "read" })).toContain("agent-browser get 'text' 'body'");
    expect(browserScreenshotCommandLine("/tmp/s.png", true)).toContain("agent-browser screenshot '--full' '/tmp/s.png' >&2 && base64 -w0 '/tmp/s.png'");
  });
});

describe("runBrowserAction", () => {
  it("runs in the browser target and marks page text as data", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, processId: "p", stderr: "", stdout: "- button \"Войти\" [ref=e1]\n" }));
    const result = await runBrowserAction({
      action: { action: "snapshot" },
      runner: { run, writeFile: vi.fn() },
      scope: "personal",
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ target: "browser", timeoutMs: 50_000 }));
    expect(result).toMatchObject({ action: "snapshot", output: "- button \"Войти\" [ref=e1]", note: expect.stringContaining("данные сайта") });
  });

  it("writes a screenshot into shots/ of the chat's workspace", async () => {
    const png = Buffer.from("png-bytes");
    const writeFile = vi.fn(async () => undefined);
    const result = await runBrowserAction({
      action: { action: "screenshot", fullPage: false },
      now: () => new Date("2026-10-08T20:00:00Z"),
      runner: { run: async () => ({ exitCode: 0, processId: "p", stderr: "", stdout: png.toString("base64") }), writeFile },
      scope: "family",
    });
    expect(result).toMatchObject({ action: "screenshot", bytes: png.length, scope: "family" });
    expect(String(result.path)).toMatch(/^shots\/browser-20261008T200000-[0-9a-f]{8}\.png$/u);
    expect(writeFile).toHaveBeenCalledWith(`/workspace/family/${String(result.path)}`, png);
  });

  it("reports a timeout and a failure without the query string", async () => {
    const timeout = { exitCode: 124, processId: "p", stderr: "", stdout: "" };
    await expect(runBrowserAction({ action: { action: "click", ref: "@e1" }, runner: { run: async () => timeout, writeFile: vi.fn() }, scope: "personal" }))
      .rejects.toMatchObject({ code: "AGENT_BROWSER_TIMEOUT" });
    // A slow page usually loaded anyway.
    await expect(runBrowserAction({ action: { action: "open", url: "https://example.com/" }, runner: { run: async () => timeout, writeFile: vi.fn() }, scope: "personal" }))
      .resolves.toMatchObject({ loaded: false });
    const failed = { exitCode: 1, processId: "p", stderr: "net::ERR at https://bank.example/pay?token=secret", stdout: "" };
    const error = await runBrowserAction({ action: { action: "open", url: "https://bank.example/" }, runner: { run: async () => failed, writeFile: vi.fn() }, scope: "personal" })
      .catch((caught: unknown) => caught as { code: string; message: string });
    expect(error).toMatchObject({ code: "AGENT_BROWSER_FAILED" });
    expect(JSON.stringify(error)).not.toContain("secret");
  });
});
