/**
 * Docker-backed implementation of the private sandbox runner engine.
 *
 * Exports:
 * - `buildSandboxContainerOptions`: re-exported pure container policy builder.
 * - `SandboxEngineHardening`: the isolation the engine applies around every container run.
 * - `createDockerSandboxEngine`: durable scoped container lifecycle and I/O.
 * - `resolveSandboxRuntimeImage`, `resolveSandboxDockerRuntime`: re-exported runtime discovery.
 *
 * Key constructs:
 * - Every start of a container (creation, resume, the reap's restart) passes the capacity gate
 *   and then `prepareRun` (the egress firewall) before any process runs in it, the runner's own
 *   tool initialization included.
 * - After each Bash command, when it was the session's only operation, the processes it left
 *   behind are killed; a failed sweep stops the container (fail closed).
 * - The container root is read-only: files and seeds travel through a process's stdin and stdout
 *   (`docker-sandbox-transfer.ts`), never through Docker's archive API or a staging directory.
 * - Before a Bash command or a file write the disk budget of every mounted scope is checked; past
 *   it a command gets exit 125 with the refusal, and only cleanup commands run.
 * - A process with `target: "browser"` runs in the session's browser companion
 *   (`docker-sandbox-browser.ts`), obtained under the session's creation lock; no sweep, no disk
 *   budget (it has no workspace), one browser command of a session at a time.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { posix } from "node:path";

import type Docker from "dockerode";

import {
  SANDBOX_RUNNER_MAX_OUTPUT_BYTES,
  SANDBOX_RUNNER_TIMEOUT_MAX_MS,
  type SandboxRunnerCreateRequest,
  type SandboxRunnerRemovePathRequest,
  type SandboxRunnerSessionResponse,
} from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import type { SandboxEngine } from "./sandbox-engine.js";
import { collectLimitedStream } from "./docker-sandbox-files.js";
import {
  assertShellSafePath,
  initializeToolEnvironmentCommand,
} from "./docker-sandbox-commands.js";
import { createCapacityGate } from "./docker-sandbox-capacity.js";
import {
  type ContainerReady,
  dockerStatus,
  inspectContainer,
  requireRunningContainer,
  startContainer,
} from "./docker-sandbox-container.js";
import { SANDBOX_FIREWALL_LABEL } from "./docker-sandbox-firewall.js";
import {
  executeSandboxProcess,
  processTimedOut,
  SANDBOX_SYSTEM_PATH,
} from "./docker-sandbox-process.js";
import {
  createSandboxRepeatGuard,
  SANDBOX_REPEAT_REFUSED_EXIT_CODE,
  SANDBOX_REPEAT_REFUSED_MESSAGE,
  sandboxCommandFingerprint,
} from "./sandbox-repeat-guard.js";
import {
  createSandboxActivityRegistry,
  SANDBOX_IDLE_TIMEOUT_MS,
  sandboxContainerName,
  sandboxContainerNeedsReplacement,
  sandboxRequestHash,
} from "./docker-sandbox-lifecycle.js";
import { reconcileSandboxContainers } from "./docker-sandbox-reconciliation.js";
import type { RuntimeRoots } from "./docker-sandbox-runtime.js";
import {
  readContainerFile,
  writeContainerFile,
  writeSeedFiles,
} from "./docker-sandbox-transfer.js";
import {
  isCleanupCommand,
  SANDBOX_DISK_REFUSED_EXIT_CODE,
  type SandboxDiskQuota,
  sessionScopes,
} from "./sandbox-disk-quota.js";
import { createSkillWriteAllowance } from "./sandbox-skill-allowance.js";
import {
  browserStateSubpath,
  buildSandboxContainerOptions,
  resolveTrustedToolMount,
  type SandboxDockerRuntime,
} from "./docker-sandbox-options.js";
import { executeGoogleWorkspaceContainer } from "./google-workspace-container.js";
import {
  migrateBrowserState,
  removeBrowserContainer,
  requireBrowserContainer,
} from "./docker-sandbox-browser.js";

export { buildSandboxContainerOptions } from "./docker-sandbox-options.js";
export {
  resolveSandboxDockerRuntime,
  resolveSandboxRuntimeImage,
} from "./docker-sandbox-runtime.js";

const SANDBOX_SESSION_LABEL = "dev.osinara.sandbox.session-id";
const SANDBOX_PROJECT_LABEL = "dev.osinara.sandbox.project";
const SANDBOX_REQUEST_HASH_LABEL = "dev.osinara.sandbox.request-hash";
const GOOGLE_WORKSPACE_EXECUTION_LABEL = "dev.osinara.google-workspace-execution";

export interface SandboxEngineHardening {
  /** The disk budget of the scopes a container mounts. */
  diskQuota: SandboxDiskQuota;
  /** Running sandbox containers allowed at once. */
  maxRunning: number;
  /** Awaited for every container run before use: the egress firewall of a trusted sandbox. */
  prepareRun: ContainerReady;
  /** Kills what a finished command left behind; the number of killed processes. */
  sweepStrays: (container: Docker.Container) => Promise<number>;
}

function resolvePath(path: string): string {
  assertShellSafePath(path);
  const normalized = path.startsWith("/") ? posix.normalize(path) : posix.resolve("/workspace", path);
  const allowed = ["/tmp", "/tools", "/workspace"].some((root) =>
    normalized === root || normalized.startsWith(`${root}/`)
  );
  if (!allowed) {
    throw new Error("AGENT_SANDBOX_RUNNER_PATH_INVALID: Path is outside sandbox writable roots");
  }
  return normalized;
}

async function requireDirectory(path: string, code: string): Promise<void> {
  // Validate the named-volume subdirectory itself, not a different scope behind a symlink.
  const metadata = await lstat(path);
  if (!metadata.isDirectory()) throw new Error(`${code}: Required path is not a directory`);
}

async function ensureToolDirectories(
  docker: Docker,
  container: Docker.Container,
  request: SandboxRunnerCreateRequest,
): Promise<void> {
  if (request.access !== "trusted") return;
  const mount = resolveTrustedToolMount(request.mounts);
  const root = `/tools/${mount.mountPoint}`;
  const directories = [`${root}/bin`, `${root}/cache`, `${root}/home`, `${root}/npm`];
  const python = `${root}/python`;
  const command = initializeToolEnvironmentCommand({ directories, pythonRoot: python });
  const result = await executeSandboxProcess(docker, container, {
    command,
    // The runner's own command: the tools volume's bin directories head the session PATH.
    environment: { PATH: SANDBOX_SYSTEM_PATH },
    timeoutMs: SANDBOX_RUNNER_TIMEOUT_MAX_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(`AGENT_SANDBOX_RUNNER_TOOL_ENV_INIT_FAILED: ${result.stderr}`);
  }
}

export function createDockerSandboxEngine(input: {
  docker: Docker;
  hardening: SandboxEngineHardening;
  roots: RuntimeRoots;
  runtime: SandboxDockerRuntime;
}): SandboxEngine {
  const activity = createSandboxActivityRegistry(Date.now);
  const repeatGuard = createSandboxRepeatGuard(Date.now);
  const skillAllowance = createSkillWriteAllowance();
  const withCapacity = createCapacityGate({
    activity,
    docker: input.docker,
    maxRunning: input.hardening.maxRunning,
    now: Date.now,
    project: input.runtime.project,
  });
  const running = async (sessionId: string) => await requireRunningContainer({
    activeOperations: activity.activeCount(sessionId),
    docker: input.docker,
    ensureReady: input.hardening.prepareRun,
    gateStart: (start) => withCapacity(sessionId, start),
    sessionId,
  });
  const browserQueues = new Map<string, Promise<unknown>>();
  /** One browser command of a session at a time: the companion drives one Chromium. */
  const runInBrowser = async (
    sessionId: string,
    request: { command: string; timeoutMs?: number },
    signal?: AbortSignal,
  ) => {
    const previous = browserQueues.get(sessionId) ?? Promise.resolve();
    const turn = previous.catch(() => undefined).then(async () => {
      const companion = await activity.runExclusive(sessionId, async () => await requireBrowserContainer({
        activeOperations: activity.activeCount(sessionId),
        docker: input.docker,
        ensureReady: input.hardening.prepareRun,
        gateStart: (start) => withCapacity(sessionId, start),
        runtime: input.runtime,
        sessionId,
        toolsRoot: input.roots.toolsRoot,
      }));
      return await executeSandboxProcess(input.docker, companion, {
        command: request.command,
        environment: { PATH: SANDBOX_SYSTEM_PATH },
        timeoutMs: request.timeoutMs,
      }, signal);
    });
    browserQueues.set(sessionId, turn);
    try {
      return await turn;
    } finally {
      if (browserQueues.get(sessionId) === turn) browserQueues.delete(sessionId);
    }
  };
  const sweepAfterCommand = async (sessionId: string, container: Docker.Container) => {
    await activity.runAlone(sessionId, async () => {
      try {
        const killed = await input.hardening.sweepStrays(container);
        if (killed > 0) {
          console.info(JSON.stringify({ code: "AGENT_SANDBOX_RUNNER_STRAYS_KILLED", killed, sessionId }));
        }
      } catch (error) {
        // A sweep that could not run leaves unknown processes behind: the run ends instead.
        console.error(JSON.stringify({
          code: "AGENT_SANDBOX_RUNNER_CLEANUP_FAILED",
          error: error instanceof Error ? error.message.slice(0, 400) : String(error),
          sessionId,
        }));
        await container.stop({ t: 0 }).catch(() => undefined);
      }
    });
  };

  return {
    async health() {
      await input.docker.ping();
      await input.docker.getImage(input.runtime.image).inspect();
    },
    async createSession(request): Promise<SandboxRunnerSessionResponse> {
      const sessionId = request.sandboxSessionId;
      return await activity.runExclusive(sessionId, () => activity.runActive(sessionId, async () => {
        for (const mount of request.mounts) {
          await mkdir(`${input.roots.workspaceRoot}/${mount.workspaceId}`, { recursive: true });
          await requireDirectory(
            `${input.roots.workspaceRoot}/${mount.workspaceId}`,
            "AGENT_SANDBOX_RUNNER_WORKSPACE_MISSING",
          );
        }
        if (request.access === "trusted") {
          // Exactly one verified scope owns HOME and the read-only Google profile mount.
          const toolMount = resolveTrustedToolMount(request.mounts);
          const toolsPath = `${input.roots.toolsRoot}/${toolMount.workspaceId}`;
          await mkdir(toolsPath, { recursive: true });
          await requireDirectory(toolsPath, "AGENT_SANDBOX_RUNNER_TOOLS_MISSING");
          // Before any Bash of policy 16 can run: the logged-in state leaves the tool environment.
          await migrateBrowserState(input.roots.toolsRoot, toolMount.workspaceId);
        }

        let existing = await inspectContainer(input.docker, sessionId);
        const labels = existing?.inspection.Config.Labels;
        if (existing && sandboxContainerNeedsReplacement({
          requestHash: labels?.[SANDBOX_REQUEST_HASH_LABEL],
          sandboxSessionId: labels?.[SANDBOX_SESSION_LABEL],
        }, request)) {
          if (request.seedFiles === undefined) {
            return { created: false, seedRequired: true, sessionId };
          }
          // Workspace and tools are named-volume subpaths, so stale compute is disposable.
          await existing.container.remove({ force: true, v: true });
          existing = null;
        }
        if (existing) {
          await running(sessionId);
          return { created: false, seedRequired: false, sessionId };
        }
        if (request.seedFiles === undefined) {
          return { created: false, seedRequired: true, sessionId };
        }

        const options = buildSandboxContainerOptions(input.runtime, request);
        options.name = sandboxContainerName(sessionId);
        options.Labels = {
          ...options.Labels,
          [SANDBOX_REQUEST_HASH_LABEL]: sandboxRequestHash(request),
        };
        const container = await input.docker.createContainer(options);
        try {
          await withCapacity(sessionId, () => startContainer(container));
          await input.hardening.prepareRun(container, await container.inspect());
          await ensureToolDirectories(input.docker, container, request);
          await writeSeedFiles(input.docker, container, request.seedFiles);
        } catch (error) {
          await container.remove({ force: true, v: true }).catch(() => undefined);
          throw error;
        }
        return { created: true, seedRequired: false, sessionId };
      }));
    },
    async runProcess(sessionId, request, signal) {
      if (request.target === "browser") {
        return await activity.runActive(sessionId, async () => await runInBrowser(sessionId, request, signal));
      }
      return await activity.runActive(sessionId, async () => {
        const processRequest = request.workingDirectory
          ? { ...request, workingDirectory: resolvePath(request.workingDirectory) }
          : request;
        const fingerprint = sandboxCommandFingerprint(
          processRequest.command,
          processRequest.workingDirectory,
        );
        if (repeatGuard.refuses(sessionId, fingerprint)) {
          console.error(JSON.stringify({
            code: "AGENT_SANDBOX_RUNNER_REPEAT_REFUSED",
            sessionId,
          }));
          return {
            exitCode: SANDBOX_REPEAT_REFUSED_EXIT_CODE,
            processId: randomUUID(),
            stderr: SANDBOX_REPEAT_REFUSED_MESSAGE,
            stdout: "",
          };
        }
        const { container, inspection } = await running(sessionId);
        const refusal = await input.hardening.diskQuota.refusal(
          sessionScopes(inspection, input.runtime, input.roots),
        );
        if (refusal && !isCleanupCommand(processRequest.command)) {
          return {
            exitCode: SANDBOX_DISK_REFUSED_EXIT_CODE,
            processId: randomUUID(),
            stderr: refusal,
            stdout: "",
          };
        }
        // Past a refusal only the system's own rm, ls, du and df run, not ones planted in PATH.
        const commandRequest = refusal
          ? { ...processRequest, environment: { ...processRequest.environment, PATH: SANDBOX_SYSTEM_PATH } }
          : processRequest;
        const result = await executeSandboxProcess(input.docker, container, commandRequest, signal);
        if (processTimedOut(result)) repeatGuard.recordTimeout(sessionId, fingerprint);
        await sweepAfterCommand(sessionId, container);
        return result;
      });
    },
    async runGoogleWorkspace(request, signal) {
      return await executeGoogleWorkspaceContainer({
        docker: input.docker,
        request,
        runtime: input.runtime,
        signal,
      });
    },
    async readFile(sessionId, path) {
      return await activity.runActive(sessionId, async () => {
        const { container } = await running(sessionId);
        return await readContainerFile(input.docker, container, resolvePath(path));
      });
    },
    async writeFile(sessionId, path, content) {
      await activity.runActive(sessionId, async () => {
        const { container, inspection } = await running(sessionId);
        const resolved = resolvePath(path);
        const refusal = await input.hardening.diskQuota.refusal(
          sessionScopes(inspection, input.runtime, input.roots),
        );
        if (refusal && !skillAllowance.allows(inspection, resolved, content.byteLength)) {
          throw new Error(refusal);
        }
        await writeContainerFile(input.docker, container, resolved, content);
      });
    },
    async removePath(sessionId, request: SandboxRunnerRemovePathRequest) {
      await activity.runActive(sessionId, async () => {
        const { container } = await running(sessionId);
        const args = ["/usr/bin/rm"];
        if (request.force) args.push("-f");
        if (request.recursive) args.push("-r");
        args.push("--", resolvePath(request.path));
        const exec = await container.exec({
          AttachStderr: true,
          AttachStdout: true,
          Cmd: args,
          Env: [`PATH=${SANDBOX_SYSTEM_PATH}`],
          Tty: false,
        });
        await collectLimitedStream(await exec.start({ Tty: false }), SANDBOX_RUNNER_MAX_OUTPUT_BYTES);
        const inspection = await exec.inspect();
        if (inspection.ExitCode !== 0) {
          throw new Error("AGENT_SANDBOX_RUNNER_REMOVE_FAILED: Could not remove sandbox path");
        }
      });
    },
    async stopSession(sessionId) {
      await removeBrowserContainer(input.docker, sessionId);
      const existing = await inspectContainer(input.docker, sessionId);
      if (existing) {
        await existing.container.remove({ force: true, v: true }).catch((error) => {
          if (dockerStatus(error) !== 404) throw error;
        });
      }
      activity.forget(sessionId);
      repeatGuard.forget(sessionId);
    },
    async reconcileIdleSessions(now) {
      const cutoffMs = now.getTime() - SANDBOX_IDLE_TIMEOUT_MS;
      return await reconcileSandboxContainers({
        activity,
        docker: input.docker,
        idleCutoffMs: cutoffMs,
        nowMs: now.getTime(),
        project: input.runtime.project,
      });
    },
    async stopAllSessions() {
      const containers = await input.docker.listContainers({
        all: true,
        filters: {
          label: [`${SANDBOX_PROJECT_LABEL}=${input.runtime.project}`],
        },
      });
      const owned = containers.filter((item) =>
        item.Labels[SANDBOX_SESSION_LABEL] !== undefined ||
        item.Labels[GOOGLE_WORKSPACE_EXECUTION_LABEL] === "true" ||
        item.Labels[SANDBOX_FIREWALL_LABEL] === "true"
      );
      await Promise.all(owned.map(async (item) => {
        await input.docker.getContainer(item.Id).remove({ force: true, v: true }).catch((error) => {
          if (dockerStatus(error) !== 404) throw error;
        });
      }));
      activity.clear();
    },
    async deleteToolEnvironment(workspaceId) {
      await rm(`${input.roots.toolsRoot}/${workspaceId}`, { force: true, recursive: true });
      await rm(`${input.roots.toolsRoot}/${browserStateSubpath(workspaceId)}`, { force: true, recursive: true });
    },
  };
}
