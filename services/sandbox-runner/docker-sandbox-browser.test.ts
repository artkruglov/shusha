/**
 * The browser companion container of a trusted sandbox session.
 *
 * Constructs covered:
 * - Browser commands run in a companion of the session's trusted container: only browser state
 *   from `browser/<workspace>` of the tools volume (no workspace, no tool environment), the
 *   logged-in session in its environment, the session label for capacity and idle stop, role and
 *   parent labels (ported from ilkruglov 1f1e990c with our engine's hardening input).
 * - The logged-in restore state leaves the tool environment once (marker): moved unless the
 *   browser has its own, every other logged-in file and autosave candidate deleted, a linked
 *   source not followed; the session's container creation runs it before the container exists.
 * - A restricted session has no browser; a companion of an older policy or of an earlier
 *   container of the session is replaced; stopping the session removes it; the capacity cap
 *   counts the session's own running container.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";

import { migrateBrowserState, sandboxBrowserContainerName } from "./docker-sandbox-browser.js";
import { createDockerSandboxEngine } from "./docker-sandbox-engine.js";
import { sandboxContainerName } from "./docker-sandbox-lifecycle.js";
import { buildBrowserContainerOptions, SANDBOX_CONTAINER_POLICY_VERSION } from "./docker-sandbox-options.js";

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERSONAL = "11111111-1111-4111-8111-111111111111";
const runtime = {
  egressNetwork: "osinara_sandbox-egress",
  image: "osinara-sandbox-runtime:local",
  project: "osinara",
  toolsVolume: "osinara_tool-environments",
  workspaceVolume: "osinara_workspace-data",
};
const roots: string[] = [];
const ready = vi.fn(async () => undefined);
const hardening = (maxRunning = 10) => ({
  diskQuota: { refusal: async () => null },
  maxRunning,
  prepareRun: ready,
  sweepStrays: async () => 0,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function toolsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "osinara-browser-"));
  roots.push(root);
  return root;
}

const missing = Object.assign(new Error("no such container"), { statusCode: 404 });

function volume(target: string, source: string, subpath: string) {
  return { Source: source, Target: target, Type: "volume", VolumeOptions: { Subpath: subpath } };
}

/** A Docker stub with the session's own container and whatever the engine creates by name. */
function dockerWith(sessionMounts: unknown[], companion?: { labels: Record<string, string> }) {
  const created: Array<{ options: Docker.ContainerCreateOptions; started: boolean }> = [];
  const removed: string[] = [];
  const exec = vi.fn(async () => ({
    inspect: vi.fn(async () => ({ ExitCode: 0 })),
    start: vi.fn(async () => Readable.from([])),
  }));
  const containers = new Map<string, unknown>();
  containers.set(sandboxContainerName(SESSION_ID), {
    inspect: vi.fn(async () => ({
      Config: { Labels: { "dev.osinara.sandbox.eve-session-id": "wrun_1" } },
      HostConfig: { Mounts: sessionMounts },
      Id: "session",
      State: { Running: true, StartedAt: "2026-10-05T00:00:00Z" },
    })),
    remove: vi.fn(async () => { removed.push("session"); }),
  });
  if (companion) {
    containers.set(sandboxBrowserContainerName(SESSION_ID), {
      exec,
      inspect: vi.fn(async () => ({
        Config: { Labels: companion.labels },
        Id: "old-browser",
        State: { Running: true, StartedAt: "2026-10-05T00:00:00Z" },
      })),
      remove: vi.fn(async () => { removed.push("old-browser"); }),
      top: vi.fn(async () => ({ Processes: [] })),
    });
  }
  const docker = {
    createContainer: vi.fn(async (options: Docker.ContainerCreateOptions) => {
      const entry = { options, started: false };
      created.push(entry);
      const container = {
        exec,
        inspect: vi.fn(async () => ({ Config: { Labels: options.Labels }, Id: options.name, State: { Running: entry.started, StartedAt: "2026-10-05T00:00:01Z" } })),
        remove: vi.fn(async () => { removed.push(options.name!); }),
        start: vi.fn(async () => { entry.started = true; }),
        top: vi.fn(async () => ({ Processes: [] })),
      };
      containers.set(options.name!, container);
      return container;
    }),
    getContainer: vi.fn((name: string) => containers.get(name) ?? { inspect: vi.fn(async () => Promise.reject(missing)) }),
    listContainers: vi.fn(async () => []),
    modem: {
      demuxStream: vi.fn((stream: Readable, stdout: NodeJS.WritableStream) => {
        stream.pipe(stdout as NodeJS.WritableStream & import("node:stream").Writable);
      }),
    },
  } as unknown as Docker;
  return { created, docker, exec, removed };
}

describe("buildBrowserContainerOptions", () => {
  it("mounts only the browser state, with the logged-in session and no Bash tools", () => {
    const options = buildBrowserContainerOptions(runtime, {
      eveSessionId: "wrun_1",
      parentContainerId: "session",
      sandboxSessionId: SESSION_ID,
      toolsWorkspaceId: PERSONAL,
    });
    expect(options.HostConfig?.Mounts).toEqual([
      expect.objectContaining(volume("/browser", runtime.toolsVolume, `browser/${PERSONAL}`)),
    ]);
    expect(options.Env).toEqual(expect.arrayContaining([
      "AGENT_BROWSER_SESSION=osinara",
      "AGENT_BROWSER_RESTORE=osinara",
      "HOME=/browser/home",
    ]));
    expect(options.Env?.some((entry) => entry.includes("/tools/"))).toBe(false);
    expect(options.HostConfig).toMatchObject({ CapDrop: ["ALL"], NetworkMode: runtime.egressNetwork, Privileged: false });
    expect(options.Labels).toMatchObject({
      "dev.osinara.sandbox.policy-version": SANDBOX_CONTAINER_POLICY_VERSION,
      "dev.osinara.sandbox.parent-container": "session",
      "dev.osinara.sandbox.role": "browser",
      "dev.osinara.sandbox.session-id": SESSION_ID,
    });
  });
});

describe("migrateBrowserState", () => {
  const sessionsOf = (root: string) => join(root, PERSONAL, "home/.agent-browser/sessions");
  const browserOf = (root: string) => join(root, "browser", PERSONAL, "home/.agent-browser/sessions");

  it("moves the restore file, deletes the other logged-in files and candidates, keeps the reader's, once", async () => {
    const root = await toolsRoot();
    const sessions = sessionsOf(root);
    await mkdir(join(sessions, ".tmp"), { recursive: true });
    await writeFile(join(sessions, "osinara-osinara.json"), "{\"cookies\":[]}");
    await writeFile(join(sessions, "osinara-osinara.json.previous"), "old");
    await writeFile(join(sessions, ".tmp", "osinara-osinara-candidate-1.json"), "autosave");
    await writeFile(join(sessions, "osinara-reader.json"), "{}");

    await migrateBrowserState(root, PERSONAL);
    expect(await readdir(sessions)).toEqual([".tmp", "osinara-reader.json"]);
    expect(await readdir(join(sessions, ".tmp"))).toEqual([]);
    expect(await readdir(browserOf(root))).toEqual(["osinara-osinara.json"]);

    // Files Bash writes later under these names are never imported.
    await writeFile(join(sessions, "osinara-osinara.json"), "planted");
    await rm(join(browserOf(root), "osinara-osinara.json"));
    await migrateBrowserState(root, PERSONAL);
    expect(await readdir(browserOf(root))).toEqual([]);
  });

  it("keeps the browser's own state and deletes the copy left for Bash", async () => {
    const root = await toolsRoot();
    await mkdir(sessionsOf(root), { recursive: true });
    await mkdir(browserOf(root), { recursive: true });
    await writeFile(join(sessionsOf(root), "osinara-osinara.json"), "old");
    await writeFile(join(browserOf(root), "osinara-osinara.json"), "current");

    await migrateBrowserState(root, PERSONAL);
    expect(await readdir(sessionsOf(root))).toEqual([]);
    expect(await readFile(join(browserOf(root), "osinara-osinara.json"), "utf8")).toBe("current");
  });

  it("does not follow a source replaced by a link", async () => {
    const root = await toolsRoot();
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, "osinara-osinara.json"), "not ours");
    await mkdir(join(root, PERSONAL, "home/.agent-browser"), { recursive: true });
    await symlink(elsewhere, sessionsOf(root));

    await migrateBrowserState(root, PERSONAL);
    expect(await readdir(elsewhere)).toEqual(["osinara-osinara.json"]);
    expect(await readdir(browserOf(root))).toEqual([]);
  });
});

describe("browser target of the engine", () => {
  const trustedMounts = [
    volume("/workspace/personal", runtime.workspaceVolume, PERSONAL),
    volume("/tools/personal", runtime.toolsVolume, PERSONAL),
  ];

  it("runs a browser command in a companion created from the session's container", async () => {
    const root = await toolsRoot();
    const { created, docker, exec } = dockerWith(trustedMounts);
    const engine = createDockerSandboxEngine({ docker, hardening: hardening(), roots: { toolsRoot: root, workspaceRoot: root }, runtime });

    await engine.runProcess(SESSION_ID, { command: "agent-browser get url", target: "browser" });
    await engine.runProcess(SESSION_ID, { command: "agent-browser get title", target: "browser" });

    expect(created).toHaveLength(1);
    expect(created[0]!.options.name).toBe(sandboxBrowserContainerName(SESSION_ID));
    expect(created[0]!.started).toBe(true);
    expect(created[0]!.options.HostConfig?.Mounts).toEqual([
      expect.objectContaining(volume("/browser", runtime.toolsVolume, `browser/${PERSONAL}`)),
    ]);
    expect(created[0]!.options.Labels).toMatchObject({ "dev.osinara.sandbox.parent-container": "session" });
    expect(exec).toHaveBeenCalledTimes(2);
    // The companion's run gets its network rules before any command.
    expect(ready).toHaveBeenCalled();
    expect(await readdir(join(root, "browser", PERSONAL))).toContain("home");
  });

  it("has no browser beside a restricted session", async () => {
    const root = await toolsRoot();
    const { created, docker } = dockerWith([volume("/workspace/group", runtime.workspaceVolume, PERSONAL)]);
    const engine = createDockerSandboxEngine({ docker, hardening: hardening(), roots: { toolsRoot: root, workspaceRoot: root }, runtime });

    await expect(engine.runProcess(SESSION_ID, { command: "agent-browser get url", target: "browser" }))
      .rejects.toThrow("AGENT_SANDBOX_RUNNER_BROWSER_UNAVAILABLE");
    expect(created).toHaveLength(0);
  });

  it.each([
    ["an older policy", { "dev.osinara.sandbox.parent-container": "session", "dev.osinara.sandbox.policy-version": "15" }],
    ["an earlier container of the session", { "dev.osinara.sandbox.parent-container": "replaced", "dev.osinara.sandbox.policy-version": SANDBOX_CONTAINER_POLICY_VERSION }],
  ])("replaces a companion of %s and removes it with the session", async (_label, labels) => {
    const root = await toolsRoot();
    const { created, docker, removed } = dockerWith(trustedMounts, { labels });
    const engine = createDockerSandboxEngine({ docker, hardening: hardening(), roots: { toolsRoot: root, workspaceRoot: root }, runtime });

    await engine.runProcess(SESSION_ID, { command: "agent-browser get url", target: "browser" });
    expect(removed).toEqual(["old-browser"]);
    expect(created).toHaveLength(1);

    await engine.stopSession(SESSION_ID);
    expect(removed).toEqual(["old-browser", sandboxBrowserContainerName(SESSION_ID), "session"]);
  });
});

describe("capacity with a companion", () => {
  it("counts the session's own running container when its browser starts", async () => {
    const root = await toolsRoot();
    const { created, docker } = dockerWith([
      volume("/workspace/personal", runtime.workspaceVolume, PERSONAL),
      volume("/tools/personal", runtime.toolsVolume, PERSONAL),
    ]);
    (docker as unknown as { listContainers: () => Promise<unknown[]> }).listContainers = async () => [
      { Id: "session", Labels: { "dev.osinara.sandbox.session-id": SESSION_ID }, State: "running" },
    ];
    const engine = createDockerSandboxEngine({
      docker,
      hardening: hardening(1),
      roots: { toolsRoot: root, workspaceRoot: root },
      runtime,
    });

    await expect(engine.runProcess(SESSION_ID, { command: "agent-browser get url", target: "browser" }))
      .rejects.toThrow("AGENT_SANDBOX_RUNNER_CAPACITY_EXHAUSTED");
    expect(created[0]?.started).toBe(false);
  });
});

describe("session creation and the logged-in state", () => {
  it("moves the state out of the tool environment before the session's container exists", async () => {
    const root = await toolsRoot();
    const sessions = join(root, PERSONAL, "home/.agent-browser/sessions");
    await mkdir(sessions, { recursive: true });
    await mkdir(join(root, PERSONAL), { recursive: true });
    await writeFile(join(sessions, "osinara-osinara.json"), "{}");
    let leftForBash: string[] | null = null;
    const docker = {
      createContainer: vi.fn(async () => {
        leftForBash = await readdir(sessions);
        throw new Error("stop here");
      }),
      getContainer: vi.fn(() => ({ inspect: vi.fn(async () => Promise.reject(missing)) })),
      listContainers: vi.fn(async () => []),
    } as unknown as Docker;
    const engine = createDockerSandboxEngine({ docker, hardening: hardening(), roots: { toolsRoot: root, workspaceRoot: root }, runtime });

    await expect(engine.createSession({
      access: "trusted",
      eveSessionId: "wrun_1",
      mounts: [{ mountPoint: "personal", workspaceId: PERSONAL }],
      sandboxSessionId: SESSION_ID,
      seedDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      seedFiles: [],
    })).rejects.toThrow("stop here");
    expect(leftForBash).toEqual([]);
    expect(await readdir(join(root, "browser", PERSONAL, "home/.agent-browser/sessions"))).toEqual(["osinara-osinara.json"]);
  });
});
