/**
 * The ceiling on running sandbox containers of one runner.
 *
 * Exports:
 * - `SANDBOX_MAX_RUNNING_DEFAULT`, `SANDBOX_MAX_RUNNING_LIMIT`: the default and the upper bound.
 * - `resolveSandboxMaxRunning`: reads `SANDBOX_MAX_RUNNING` fail-fast.
 * - `SANDBOX_CAPACITY_QUIET_MS`: how long a container must be quiet before it is stopped for room.
 * - `createCapacityGate`: every start goes through it; it makes room or refuses.
 *
 * Key constructs:
 * - The idle window alone lets as many containers run as chats were active inside it, each with
 *   up to 2 GiB of memory; with several families on one 8 GB machine that overcommits the host
 *   (port of ilkruglov 468fe353 and 41a49fd9). Before a start the gate stops the longest-quiet
 *   containers that have no operation running and were quiet for a minute (their session gets a
 *   warm start on its next command); when none can go, the start is refused with
 *   `AGENT_SANDBOX_RUNNER_CAPACITY_EXHAUSTED` rather than the host overcommitted.
 * - Checks and starts run one at a time, so two sessions cannot both take the last slot. The
 *   starting session's own running containers count too: its browser companion is a container
 *   of its own (ilkruglov fdb32c60); only other sessions' containers are stopped for room.
 */
import type Docker from "dockerode";

import type { SandboxActivityRegistry } from "./docker-sandbox-lifecycle.js";
import { dockerStatus } from "./docker-sandbox-container.js";

export const SANDBOX_MAX_RUNNING_DEFAULT = 10;
export const SANDBOX_MAX_RUNNING_LIMIT = 200;
export const SANDBOX_CAPACITY_QUIET_MS = 60_000;
const STOP_TIMEOUT_SECONDS = 5;
const SESSION_LABEL = "dev.osinara.sandbox.session-id";
const PROJECT_LABEL = "dev.osinara.sandbox.project";

export function resolveSandboxMaxRunning(environment: NodeJS.ProcessEnv): number {
  const raw = environment.SANDBOX_MAX_RUNNING;
  if (raw === undefined || raw.trim() === "") return SANDBOX_MAX_RUNNING_DEFAULT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > SANDBOX_MAX_RUNNING_LIMIT) {
    throw new Error(
      "AGENT_SANDBOX_RUNNER_MAX_RUNNING_INVALID: " +
      `SANDBOX_MAX_RUNNING должен быть целым от 1 до ${SANDBOX_MAX_RUNNING_LIMIT}`,
    );
  }
  return value;
}

export function capacityExhaustedError(running: number, max: number): Error {
  return new Error(
    "AGENT_SANDBOX_RUNNER_CAPACITY_EXHAUSTED: " +
    `Все песочницы сервера заняты (${running} из ${max}). Повторите команду через минуту.`,
  );
}

export function createCapacityGate(input: {
  activity: SandboxActivityRegistry;
  docker: Docker;
  maxRunning: number;
  now: () => number;
  project: string;
}): (sessionId: string, start: () => Promise<void>) => Promise<void> {
  let queue: Promise<unknown> = Promise.resolve();

  const makeRoom = async (sessionId: string): Promise<void> => {
    const listed = await input.docker.listContainers({
      filters: {
        label: [SESSION_LABEL, `${PROJECT_LABEL}=${input.project}`],
        status: ["running"],
      },
    });
    // The session's own running containers count (its browser companion adds one), but only
    // other sessions are stopped to make room.
    const others = listed.filter((item) => item.Labels?.[SESSION_LABEL] !== sessionId);
    let running = listed.length;
    if (running < input.maxRunning) return;
    const candidates = others
      .map((item) => ({
        id: item.Id,
        lastActiveAt: input.activity.lastActiveAt(item.Labels[SESSION_LABEL]!) ?? 0,
        sessionId: item.Labels[SESSION_LABEL]!,
      }))
      .sort((left, right) => left.lastActiveAt - right.lastActiveAt);
    const cutoffMs = input.now() - SANDBOX_CAPACITY_QUIET_MS;
    for (const candidate of candidates) {
      if (running < input.maxRunning) break;
      const stopped = await input.activity.removeIfIdle(candidate.sessionId, cutoffMs, async () => {
        // Stopped meanwhile by the idle sweep (304) or removed (404): the slot is free either way.
        await input.docker.getContainer(candidate.id).stop({ t: STOP_TIMEOUT_SECONDS })
          .catch((error: unknown) => {
            const status = dockerStatus(error);
            if (status !== 304 && status !== 404) throw error;
          });
      });
      if (!stopped) continue;
      running -= 1;
      console.info(JSON.stringify({
        code: "AGENT_SANDBOX_RUNNER_CAPACITY_STOPPED",
        forSessionId: sessionId,
        sessionId: candidate.sessionId,
      }));
    }
    if (running >= input.maxRunning) {
      console.error(JSON.stringify({
        code: "AGENT_SANDBOX_RUNNER_CAPACITY_EXHAUSTED",
        maxRunning: input.maxRunning,
        running,
        sessionId,
      }));
      throw capacityExhaustedError(running, input.maxRunning);
    }
  };

  return async (sessionId, start) => {
    const turn = queue.then(async () => {
      await makeRoom(sessionId);
      await start();
    });
    queue = turn.catch(() => undefined);
    await turn;
  };
}
