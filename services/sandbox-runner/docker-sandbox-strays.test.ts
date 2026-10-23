/**
 * Stray process sweep tests.
 *
 * Constructs covered:
 * - The sweep runs the system's timeout and an isolated Python by absolute path, with the system
 *   PATH, so nothing planted in the tool environment replaces them.
 * - The kept set holds the placeholder and the browser stack only; the script is valid Python.
 * - A failed sweep is an error, and the count is read from the output.
 */
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";

import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { SANDBOX_SYSTEM_PATH } from "./docker-sandbox-process.js";
import {
  KEPT_EXECUTABLE_PREFIXES,
  killStrayProcesses,
  strayProcessSweepScript,
} from "./docker-sandbox-strays.js";

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function containerAnswering(output: string, exitCode: number) {
  const exec = {
    inspect: vi.fn(async () => ({ ExitCode: exitCode })),
    start: vi.fn(async () => {
      const stream = new PassThrough();
      stream.end(Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, output.length]), Buffer.from(output)]));
      return stream;
    }),
  };
  return { container: { exec: vi.fn(async () => exec) } as unknown as Docker.Container, exec };
}

describe("killStrayProcesses", () => {
  it("keeps only the placeholder and the browser stack", () => {
    expect(KEPT_EXECUTABLE_PREFIXES).toEqual([
      "/usr/bin/sleep",
      "/usr/local/lib/node_modules/agent-browser/",
      "/opt/chrome/",
      "/usr/local/bin/lightpanda",
    ]);
    const script = strayProcessSweepScript();
    expect(script).toContain("os.kill(pid, signal.SIGKILL)");
    expect(script).toContain("kept_ancestor(pid)");
  });

  it.runIf(hasPython())("is a valid Python program", () => {
    expect(() => execFileSync("python3", ["-c", "import sys; compile(sys.stdin.read(), 'sweep', 'exec')"], {
      input: strayProcessSweepScript(),
    })).not.toThrow();
  });

  it("runs by absolute path with the system PATH and returns the count", async () => {
    const { container } = containerAnswering("3\n", 0);

    await expect(killStrayProcesses(container)).resolves.toBe(3);

    expect(container.exec).toHaveBeenCalledWith(expect.objectContaining({
      AttachStderr: false,
      Cmd: expect.arrayContaining(["/usr/bin/timeout", "/usr/bin/python3", "-I"]),
      Env: [`PATH=${SANDBOX_SYSTEM_PATH}`],
    }));
    const cmd = (container.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0].Cmd as string[];
    expect(cmd[0]).toBe("/usr/bin/timeout");
  });

  it("fails when the sweep exits non-zero", async () => {
    const { container } = containerAnswering("", 137);

    await expect(killStrayProcesses(container)).rejects.toThrow("AGENT_SANDBOX_RUNNER_CLEANUP_FAILED");
  });
});
