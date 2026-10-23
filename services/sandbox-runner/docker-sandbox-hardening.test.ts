/**
 * How the engine wires the isolation around container runs.
 *
 * Constructs covered:
 * - A new trusted container gets its network rules after the start and before any process runs
 *   in it; the runner's own tool initialization runs with the system PATH.
 * - Every operation on an existing run waits for its rules.
 * - After a command run alone, the strays are swept; a failed sweep stops the container; a
 *   command running beside another is not followed by a sweep.
 * - A resume refused by the capacity cap surfaces the stable code and starts nothing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDockerSandboxEngine } from "./docker-sandbox-engine.js";
import { sandboxContainerName } from "./docker-sandbox-lifecycle.js";
import { SANDBOX_SYSTEM_PATH } from "./docker-sandbox-process.js";

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERSONAL = "11111111-1111-4111-8111-111111111111";
const EVE_SESSION_ID = "wrun_01JZ8K4R0W6G73VTHX9NF2QABC";
const runtime = {
  egressNetwork: "osinara_sandbox-egress",
  image: "osinara-sandbox-runtime:local",
  project: "osinara",
  toolsVolume: "osinara_tool-environments",
  workspaceVolume: "osinara_workspace-data",
};
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function finishedExec(order: string[], label: string, hold?: PassThrough) {
  return {
    inspect: vi.fn(async () => ({ ExitCode: 0, Running: false })),
    start: vi.fn(async () => {
      order.push(label);
      if (hold) return hold;
      const stream = new PassThrough();
      stream.end();
      return stream;
    }),
  };
}

function harness(options: { running: boolean; sweep?: () => Promise<number> }) {
  const order: string[] = [];
  const execOptions: Array<{ Cmd: string[]; Env?: string[] }> = [];
  const container = {
    exec: vi.fn(async (execOption: { Cmd: string[]; Env?: string[] }) => {
      execOptions.push(execOption);
      return finishedExec(order, "exec");
    }),
    inspect: vi.fn(async () => ({
      Config: { Labels: {} },
      HostConfig: { NetworkMode: runtime.egressNetwork },
      Id: "container",
      State: { Running: options.running, StartedAt: "2026-10-08T10:00:00Z" },
    })),
    putArchive: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    start: vi.fn(async () => {
      order.push("start");
    }),
    stop: vi.fn(async () => {
      order.push("stop");
    }),
    top: vi.fn(async () => ({ Processes: [] })),
  };
  const docker = {
    createContainer: vi.fn(async () => container),
    getContainer: vi.fn(() => container),
    listContainers: vi.fn(async () => []),
    modem: {
      demuxStream: vi.fn((stream: PassThrough, stdout: PassThrough, stderr: PassThrough) => {
        stream.on("end", () => {
          stdout.end();
          stderr.end();
        });
        stream.resume();
      }),
    },
  } as unknown as Docker;
  const prepareRun = vi.fn(async () => {
    order.push("rules");
  });
  const sweepStrays = vi.fn(options.sweep ?? (async () => {
    order.push("sweep");
    return 0;
  }));
  return { container, docker, execOptions, order, prepareRun, sweepStrays };
}

async function engineFor(h: ReturnType<typeof harness>, maxRunning = 10) {
  const root = await mkdtemp(join(tmpdir(), "osinara-sandbox-hardening-"));
  roots.push(root);
  return createDockerSandboxEngine({
    docker: h.docker,
    hardening: {
      diskQuota: { refusal: async () => null },
      maxRunning,
      prepareRun: h.prepareRun,
      sweepStrays: h.sweepStrays,
    },
    roots: { toolsRoot: join(root, "tools"), workspaceRoot: join(root, "workspaces") },
    runtime,
  });
}

describe("sandbox isolation wiring", () => {
  it("lays the rules after the start and before the first process of a new trusted sandbox", async () => {
    const h = harness({ running: true });
    // No container of the session yet.
    h.docker.getContainer = vi.fn(() => ({
      inspect: async () => {
        throw Object.assign(new Error("absent"), { statusCode: 404 });
      },
    })) as never;
    const engine = await engineFor(h);

    await engine.createSession({
      access: "trusted",
      eveSessionId: EVE_SESSION_ID,
      mounts: [{ mountPoint: "personal", workspaceId: PERSONAL }],
      sandboxSessionId: SESSION,
      seedDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      seedFiles: [],
    });

    expect(h.order.slice(0, 3)).toEqual(["start", "rules", "exec"]);
    expect(h.execOptions[0]!.Env).toContain(`PATH=${SANDBOX_SYSTEM_PATH}`);
  });

  it("waits for the rules before a command and sweeps after it", async () => {
    const h = harness({ running: true });
    const engine = await engineFor(h);

    await engine.runProcess(SESSION, { command: "nohup miner &" });

    expect(h.order).toEqual(["rules", "exec", "sweep"]);
  });

  it("stops the container when the sweep fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = harness({
      running: true,
      sweep: async () => {
        throw new Error("AGENT_SANDBOX_RUNNER_CLEANUP_FAILED: exited with 137");
      },
    });
    const engine = await engineFor(h);

    const result = await engine.runProcess(SESSION, { command: "true" });

    expect(result.exitCode).toBe(0);
    expect(h.container.stop).toHaveBeenCalledWith({ t: 0 });
  });

  it("does not sweep after a command that ran beside another", async () => {
    const h = harness({ running: true });
    const hold = new PassThrough();
    let calls = 0;
    h.container.exec.mockImplementation(async () => {
      calls += 1;
      return finishedExec(h.order, "exec", calls === 1 ? hold : undefined);
    });
    const engine = await engineFor(h);

    const first = engine.runProcess(SESSION, { command: "sleep 5" });
    await vi.waitFor(() => expect(calls).toBe(1));
    await engine.runProcess(SESSION, { command: "true" });
    expect(h.sweepStrays).not.toHaveBeenCalled();
    hold.end();
    await first;
    expect(h.sweepStrays).toHaveBeenCalledOnce();
  });

  it("refuses a resume past the cap with the capacity code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = harness({ running: false });
    h.docker.listContainers = vi.fn(async () => [{
      Id: "other",
      Labels: { "dev.osinara.sandbox.session-id": "busy-session" },
    }]) as never;
    // The other session's container is running a command right now, so it cannot be stopped.
    const hold = new PassThrough();
    const busyContainer = {
      ...h.container,
      exec: vi.fn(async () => finishedExec(h.order, "busy-exec", hold)),
      inspect: vi.fn(async () => ({
        Config: { Labels: {} },
        HostConfig: { NetworkMode: runtime.egressNetwork },
        Id: "other",
        State: { Running: true, StartedAt: "2026-10-08T10:00:00Z" },
      })),
      start: vi.fn(),
    };
    const busyName = sandboxContainerName("busy-session");
    h.docker.getContainer = vi.fn((name: string) =>
      name === busyName || name === "other" ? busyContainer : h.container
    ) as never;
    const engine = await engineFor(h, 1);
    const busy = engine.runProcess("busy-session", { command: "sleep 5" });
    await vi.waitFor(() => expect(h.order).toContain("busy-exec"));

    await expect(engine.runProcess(SESSION, { command: "true" }))
      .rejects.toThrow("AGENT_SANDBOX_RUNNER_CAPACITY_EXHAUSTED");
    expect(h.container.start).not.toHaveBeenCalled();
    expect(busyContainer.stop).not.toHaveBeenCalled();
    hold.end();
    await busy;
  });
});
