/**
 * Processes a finished command left behind in its sandbox.
 *
 * Exports:
 * - `KEPT_EXECUTABLE_PREFIXES`: executables that may outlive a command (the placeholder and the
 *   browser stack the agent-browser skill uses between commands).
 * - `strayProcessSweepScript`: the in-container Python script (pure, tested on its own).
 * - `killStrayProcesses`: runs the sweep; resolves to the number of killed processes.
 *
 * Key constructs:
 * - A command could leave processes running (`nohup`, `setsid`, `&`): a miner or a reverse shell
 *   lived until the container's idle stop, half an hour later (port of the idea of ilkruglov
 *   b6e3f289). Here the browser runs in the same container as Bash (agent-browser's daemon and its
 *   Chrome for Testing or Lightpanda), and its daemon must survive between commands, so the kept
 *   set is wider than upstream's: the daemon, every Chrome process and Lightpanda.
 * - Processes are told apart by `/proc/<pid>/exe`. A process that made itself non-dumpable hides
 *   its executable; it is kept only when one of its ancestors is a kept executable (Chrome does
 *   that), otherwise it is killed. Before the root filesystem is read-only the model could
 *   overwrite a kept executable; the read-only root closes that.
 * - The tools are named by absolute path with the system PATH and an isolated Python: the
 *   container's PATH starts with directories the model writes, so a planted `timeout` or
 *   `python3` would otherwise run instead (Codex review of upstream, 5 October 2026).
 */
import type Docker from "dockerode";

import { SANDBOX_SYSTEM_PATH } from "./docker-sandbox-process.js";

export const KEPT_EXECUTABLE_PREFIXES = [
  "/usr/bin/sleep",
  "/usr/local/lib/node_modules/agent-browser/",
  "/opt/chrome/",
  "/usr/local/bin/lightpanda",
] as const;

const SWEEP_TIMEOUT_SECONDS = 20;

export function strayProcessSweepScript(): string {
  return `
import os, signal
keep = ${JSON.stringify(KEPT_EXECUTABLE_PREFIXES)}
me = {os.getpid(), os.getppid()}

def exe(pid):
    try:
        return os.readlink("/proc/%d/exe" % pid)
    except OSError:
        return None

def parent(pid):
    try:
        with open("/proc/%d/stat" % pid) as handle:
            return int(handle.read().rsplit(")", 1)[1].split()[1])
    except (OSError, IndexError, ValueError):
        return 0

def kept(path):
    return path is not None and any(path == k or (k.endswith("/") and path.startswith(k)) for k in keep)

def kept_ancestor(pid):
    seen = set()
    pid = parent(pid)
    while pid > 1 and pid not in seen:
        seen.add(pid)
        if kept(exe(pid)):
            return True
        pid = parent(pid)
    return False

killed = 0
for name in os.listdir("/proc"):
    if not name.isdigit():
        continue
    pid = int(name)
    if pid == 1 or pid in me:
        continue
    path = exe(pid)
    if kept(path):
        continue
    if path is None and kept_ancestor(pid):
        continue
    try:
        os.kill(pid, signal.SIGKILL)
        killed += 1
    except OSError:
        pass
print(killed)
`;
}

/** Kills what a finished command left behind; the number of killed processes. */
export async function killStrayProcesses(container: Docker.Container): Promise<number> {
  const exec = await container.exec({
    // Only the count travels back; stderr frames could carry digits of their own.
    AttachStderr: false,
    AttachStdout: true,
    Cmd: [
      "/usr/bin/timeout",
      "--signal=KILL",
      String(SWEEP_TIMEOUT_SECONDS),
      "/usr/bin/python3",
      "-I",
      "-c",
      strayProcessSweepScript(),
    ],
    Env: [`PATH=${SANDBOX_SYSTEM_PATH}`],
    Tty: false,
    WorkingDir: "/",
  });
  const stream = await exec.start({ Tty: false });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("end", () => resolve());
    stream.once("close", () => resolve());
    stream.once("error", () => resolve());
  });
  const { ExitCode } = await exec.inspect();
  if (ExitCode !== 0) {
    throw new Error(
      `AGENT_SANDBOX_RUNNER_CLEANUP_FAILED: The stray process sweep exited with ${ExitCode}`,
    );
  }
  // Docker frames the output with 8-byte headers; the count is the last number in it.
  const digits = Buffer.concat(chunks).toString("latin1").match(/\d+/gu);
  return digits ? Number(digits.at(-1)) : 0;
}
