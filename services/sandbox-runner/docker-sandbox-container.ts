/**
 * How the runner obtains a running sandbox container and names one run of it.
 *
 * Exports:
 * - `dockerStatus`: the HTTP status dockerode attaches to a failed Docker API call.
 * - `inspectContainer`: a container of a session (its own by default, or a named companion) with its
 *   inspection, or null when absent.
 * - `startContainer`: starts a stopped container; one started meanwhile counts as started.
 * - `containerGeneration`: the identity of one container run (ID and start time).
 * - `requireRunningContainer`: a started, uncrowded container whose run is ready (network rules).
 *
 * Key constructs:
 * - The pids cgroup counts threads, so a single Chromium (about 200 tasks) can exhaust the limit
 *   and every later operation fails inside the container. Crowded containers are restarted.
 * - Every start and restart creates a new network namespace, so whatever the runner lays into the
 *   namespace (the egress firewall) belongs to one run; `ensureReady` is awaited for the run the
 *   caller is about to use, whether it was started now, restarted by the reap or already running.
 */
import type Docker from "dockerode";

import { sandboxContainerName } from "./docker-sandbox-lifecycle.js";
import { SANDBOX_PIDS_REAP_THRESHOLD } from "./docker-sandbox-options.js";

/** Dockerode surfaces the HTTP status of a failed API call; 404 means the container is gone. */
export function dockerStatus(error: unknown): number | undefined {
  return (error as { statusCode?: number } | null)?.statusCode;
}

export async function inspectContainer(
  docker: Docker,
  sessionId: string,
  name = sandboxContainerName(sessionId),
): Promise<{ container: Docker.Container; inspection: Docker.ContainerInspectInfo } | null> {
  const container = docker.getContainer(name);
  try {
    return { container, inspection: await container.inspect() };
  } catch (error) {
    if (dockerStatus(error) === 404) return null;
    throw error;
  }
}

/** Two operations may find the container stopped at once; the second start answers 304. */
export async function startContainer(container: Docker.Container): Promise<void> {
  await container.start().catch((error: unknown) => {
    if (dockerStatus(error) !== 304) throw error;
  });
}

/** One run of a container: its ID and the time it last started; null when Docker gave neither. */
export function containerGeneration(inspection: Docker.ContainerInspectInfo): string | null {
  const startedAt: unknown = inspection.State?.StartedAt;
  if (!inspection.Id || typeof startedAt !== "string" || startedAt.length === 0) return null;
  return `${inspection.Id} ${startedAt}`;
}

async function countContainerTasks(container: Docker.Container): Promise<number> {
  // `docker top` runs ps on the host, so it works even when the container itself cannot fork.
  // The pids cgroup counts threads, so the per-process thread count (nlwp) is what is summed.
  const top = (await container.top({ ps_args: "-eo pid,nlwp" })) as { Processes?: unknown[] };
  if (!Array.isArray(top.Processes)) return 0;
  return top.Processes.reduce<number>((total, row) => {
    const threads = Array.isArray(row) ? Number(row[1]) : Number.NaN;
    return total + (Number.isFinite(threads) && threads > 0 ? threads : 1);
  }, 0);
}

/** True when the container was restarted, so its previous run (and its rules) is gone. */
async function reapCrowdedContainer(container: Docker.Container, sessionId: string): Promise<boolean> {
  const tasks = await countContainerTasks(container);
  if (tasks < SANDBOX_PIDS_REAP_THRESHOLD) return false;
  // Workspace and tools are named volumes; the process tree is disposable compute.
  await container.restart({ t: 0 });
  console.error(JSON.stringify({
    code: "AGENT_SANDBOX_RUNNER_PROCESSES_REAPED",
    sessionId,
    tasks,
    threshold: SANDBOX_PIDS_REAP_THRESHOLD,
  }));
  return true;
}

export type ContainerReady = (
  container: Docker.Container,
  inspection: Docker.ContainerInspectInfo,
) => Promise<void>;

export async function requireRunningContainer(input: {
  activeOperations: number;
  docker: Docker;
  ensureReady: ContainerReady;
  /** Runs the start of a stopped container; the engine passes its capacity gate. */
  gateStart: (start: () => Promise<void>) => Promise<void>;
  /** A companion of the session instead of its own container. */
  name?: string;
  sessionId: string;
}): Promise<{ container: Docker.Container; inspection: Docker.ContainerInspectInfo }> {
  const existing = await inspectContainer(input.docker, input.sessionId, input.name);
  if (!existing) throw new Error("AGENT_SANDBOX_RUNNER_SESSION_NOT_FOUND: Sandbox is absent");
  let inspection = existing.inspection;
  if (!inspection.State.Running) {
    await input.gateStart(() => startContainer(existing.container));
    inspection = await existing.container.inspect();
  } else if (input.activeOperations <= 1) {
    // A restart kills every process of the session: only the caller may be running in it.
    if (await reapCrowdedContainer(existing.container, input.sessionId)) {
      inspection = await existing.container.inspect();
    }
  }
  await input.ensureReady(existing.container, inspection);
  return { container: existing.container, inspection };
}
