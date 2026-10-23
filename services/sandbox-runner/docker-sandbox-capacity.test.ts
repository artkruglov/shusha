/**
 * Running-container cap tests.
 *
 * Constructs covered:
 * - `SANDBOX_MAX_RUNNING` defaults to 10 and is bounded fail-fast.
 * - Below the cap a start runs at once; the session's own container is not counted.
 * - At the cap the longest-quiet idle container is stopped first; an active or recently used
 *   one is never stopped; with no room the start is refused with a stable code and Russian text.
 * - Two starts racing for the last slot are serialized: only one gets it.
 */
import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCapacityGate,
  resolveSandboxMaxRunning,
  SANDBOX_CAPACITY_QUIET_MS,
} from "./docker-sandbox-capacity.js";
import { createSandboxActivityRegistry } from "./docker-sandbox-lifecycle.js";

const NOW = 10_000_000;

afterEach(() => {
  vi.restoreAllMocks();
});

function runningDocker(sessions: string[]) {
  const live = new Set(sessions);
  const stops: string[] = [];
  const docker = {
    getContainer: vi.fn((id: string) => ({
      stop: vi.fn(async () => {
        stops.push(id);
        live.delete(id);
      }),
    })),
    listContainers: vi.fn(async () => [...live].map((session) => ({
      Id: session,
      Labels: { "dev.osinara.sandbox.session-id": session },
    }))),
  } as unknown as Docker;
  return { docker, live, stops };
}

describe("resolveSandboxMaxRunning", () => {
  it("defaults to ten and accepts a bounded integer", () => {
    expect(resolveSandboxMaxRunning({})).toBe(10);
    expect(resolveSandboxMaxRunning({ SANDBOX_MAX_RUNNING: "" })).toBe(10);
    expect(resolveSandboxMaxRunning({ SANDBOX_MAX_RUNNING: "4" })).toBe(4);
  });

  it.each(["0", "-1", "2.5", "201", "ten"])("refuses %j", (value) => {
    expect(() => resolveSandboxMaxRunning({ SANDBOX_MAX_RUNNING: value }))
      .toThrow("AGENT_SANDBOX_RUNNER_MAX_RUNNING_INVALID");
  });
});

describe("createCapacityGate", () => {
  it("starts at once below the cap, counting the session's own running container", async () => {
    const { docker, stops } = runningDocker(["own", "other"]);
    const activity = createSandboxActivityRegistry(() => NOW);
    const gate = createCapacityGate({ activity, docker, maxRunning: 3, now: () => NOW, project: "osinara" });
    const start = vi.fn(async () => undefined);

    await gate("own", start);

    expect(start).toHaveBeenCalledOnce();
    expect(stops).toEqual([]);
  });

  it("counts the session's own container but never stops it to make room", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { docker, stops } = runningDocker(["own"]);
    const activity = createSandboxActivityRegistry(() => NOW);
    const gate = createCapacityGate({ activity, docker, maxRunning: 1, now: () => NOW, project: "osinara" });

    await expect(gate("own", async () => undefined)).rejects.toThrow("AGENT_SANDBOX_RUNNER_CAPACITY_EXHAUSTED");
    expect(stops).toEqual([]);
  });

  it("stops the longest-quiet idle container to make room", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { docker, stops } = runningDocker(["recent", "oldest", "older"]);
    let clock = NOW - 10 * SANDBOX_CAPACITY_QUIET_MS;
    const activity = createSandboxActivityRegistry(() => clock);
    activity.touch("oldest");
    clock += SANDBOX_CAPACITY_QUIET_MS;
    activity.touch("older");
    clock = NOW;
    activity.touch("recent");
    const gate = createCapacityGate({ activity, docker, maxRunning: 3, now: () => NOW, project: "osinara" });

    await gate("new", async () => undefined);

    expect(stops).toEqual(["oldest"]);
  });

  it("refuses with a stable code when every container is busy or recent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { docker, stops } = runningDocker(["busy", "recent"]);
    const activity = createSandboxActivityRegistry(() => NOW);
    activity.touch("recent");
    let release!: () => void;
    const busy = activity.runActive("busy", () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const gate = createCapacityGate({ activity, docker, maxRunning: 2, now: () => NOW, project: "osinara" });
    const start = vi.fn(async () => undefined);

    await expect(gate("new", start)).rejects.toThrow(
      /^AGENT_SANDBOX_RUNNER_CAPACITY_EXHAUSTED: Все песочницы сервера заняты \(2 из 2\)/u,
    );
    expect(start).not.toHaveBeenCalled();
    expect(stops).toEqual([]);
    release();
    await busy;
  });

  it("lets only one of two racing starts take the last slot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { docker, live } = runningDocker(["recent"]);
    const activity = createSandboxActivityRegistry(() => NOW);
    activity.touch("recent");
    const gate = createCapacityGate({ activity, docker, maxRunning: 2, now: () => NOW, project: "osinara" });
    const startOf = (session: string) => async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      live.add(session);
    };

    const results = await Promise.allSettled([
      // As in the engine, a starting session is inside an operation of its own.
      activity.runActive("a", () => gate("a", startOf("a"))),
      activity.runActive("b", () => gate("b", startOf("b"))),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(live.size).toBe(2);
  });
});
