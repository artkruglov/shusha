/**
 * Reads the live page of a chat's browser companion for the gate and the confirmation window.
 *
 * Export:
 * - `sandboxBrowserPageReader`: a snapshot and the address, through runner target `browser`.
 */
import { SANDBOX_RUNNER_BASE_URL } from "../../config.js";
import { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";
import type { BrowserPageReader } from "./browser-approval.js";
import { browserCommandLine } from "./browser-command.js";

const PAGE_READ_TIMEOUT_MS = 50_000;
const runner = new SandboxRunnerClient(SANDBOX_RUNNER_BASE_URL);

export function sandboxBrowserPageReader(sessionId: string, signal?: AbortSignal): BrowserPageReader {
  const read = async (action: { action: "snapshot" } | { action: "url" }) => {
    const result = await runner.run(sessionId, {
      command: browserCommandLine(action),
      target: "browser",
      timeoutMs: PAGE_READ_TIMEOUT_MS,
    }, signal);
    if (result.exitCode !== 0) throw new Error("AGENT_BROWSER_PAGE_UNREADABLE: Страница браузера не прочиталась");
    return result.stdout;
  };
  return { snapshot: async () => await read({ action: "snapshot" }), url: async () => await read({ action: "url" }) };
}
