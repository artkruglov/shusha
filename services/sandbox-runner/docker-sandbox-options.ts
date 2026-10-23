/**
 * Pure Docker container configuration for Osinara sandboxes.
 *
 * Exports:
 * - `SandboxDockerRuntime`: resolved Docker resources owned by Compose.
 * - `SANDBOX_CONTAINER_POLICY_VERSION`: invalidates containers created under older runtime policy.
 * - `buildSandboxContainerOptions`: creates fail-closed scoped container options.
 * - `buildGoogleWorkspaceContainerOptions`: creates a one-shot credential boundary.
 * - `resolveTrustedToolMount`: selects the only persistent HOME mount for a trusted session.
 * - `primaryMountPoint`: the writable workspace commands start in (the root is read-only).
 * - `buildBrowserContainerOptions`: the companion container of a trusted session that runs the
 *   logged-in Chrome, apart from the model's Bash (port of ilkruglov 1f1e990c).
 * - `BROWSER_CONTAINER_ROLE`, `SANDBOX_ROLE_LABEL`, `SANDBOX_PARENT_LABEL`, `browserStateSubpath`:
 *   how that container is labelled and where its state lives on the tools volume.
 *
 * Key construct:
 * - The logged-in browser used to run in the container of the model's Bash: the DevTools port on
 *   127.0.0.1 and the daemon socket in HOME let any command read the family's cookies
 *   (`agent-browser cookies`). Its state now lives in `browser/<workspace>` of the tools volume,
 *   which the Bash container never mounts (it gets `<workspace>` only), and the session variables
 *   of the logged-in browser are gone from Bash; the Lightpanda reader stays there (policy 16).
 */
import type Docker from "dockerode";

import type {
  GoogleWorkspaceExecutionRequest,
  SandboxRunnerCreateRequest,
  SandboxRunnerMount,
} from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";

export interface SandboxDockerRuntime {
  egressNetwork: string;
  image: string;
  project: string;
  toolsVolume: string;
  workspaceVolume: string;
}

export const SANDBOX_CONTAINER_POLICY_VERSION = "16";
export const SANDBOX_ROLE_LABEL = "dev.osinara.sandbox.role";
export const SANDBOX_PARENT_LABEL = "dev.osinara.sandbox.parent-container";
export const BROWSER_CONTAINER_ROLE = "browser";
const BROWSER_STATE_TARGET = "/browser";

/** The companion's state directory on the tools volume, beside (never inside) a tool environment. */
export function browserStateSubpath(workspaceId: string): string {
  return `browser/${workspaceId}`;
}

const AGENT_BROWSER_SESSION_NAME = "osinara";
const AGENT_BROWSER_RESTORE_SAVE_POLICY = "auto";
// One Chromium holds about 500 MiB; the default daemon idle of one hour kept it after every turn.
const AGENT_BROWSER_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
const PROXY_URL = "http://sandbox-egress-proxy:3128";
const BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const GOOGLE_WORKSPACE_BINARY = "/opt/osinara/gws";
const RUSSIAN_TRUSTED_ROOT_CA_PATH =
  "/usr/local/share/ca-certificates/russian-trusted-root-ca.crt";
const SANDBOX_CPU_NANOSECONDS = 1_000_000_000;
const SANDBOX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
// The pids cgroup counts threads, not processes: one agent-browser Chromium is about 200 tasks,
// so the former limit of 256 wedged page loads inside a single session and a second daemon hit
// EAGAIN outright. The budget now holds a few sessions; anything beyond is leftover daemons.
const SANDBOX_PIDS_LIMIT = 1024;
// Between commands only daemons stay alive (agent-browser and its Chromium tree). Once their
// threads take half the budget the next `mkdir` in the container is at risk of EAGAIN and every
// turn would die in its preamble, so the runner restarts the disposable compute first.
export const SANDBOX_PIDS_REAP_THRESHOLD = SANDBOX_PIDS_LIMIT / 2;
const SANDBOX_SHM_BYTES = 256 * 1024 * 1024;

function volumeMount(source: string, target: string, subpath: string): Docker.MountSettings {
  // Docker Engine accepts Subpath without the optional driver fields over the HTTP API.
  return {
    Source: source,
    Target: target,
    Type: "volume",
    VolumeOptions: { Subpath: subpath },
  } as Docker.MountSettings;
}

function workspaceMounts(
  runtime: SandboxDockerRuntime,
  mounts: readonly SandboxRunnerMount[],
): Docker.MountSettings[] {
  return mounts.map((mount) =>
    volumeMount(runtime.workspaceVolume, `/workspace/${mount.mountPoint}`, mount.workspaceId)
  );
}

export function resolveTrustedToolMount(
  mounts: readonly SandboxRunnerMount[],
): SandboxRunnerMount {
  // Private sessions prefer personal state; family sessions have only their family mount.
  const primary = mounts.find((mount) => mount.mountPoint === "personal") ?? mounts[0];
  if (!primary || primary.mountPoint === "group") {
    throw new Error(
      "AGENT_SANDBOX_RUNNER_TOOL_SCOPE_INVALID: Trusted tool environment is missing",
    );
  }
  return primary;
}

/** The workspace commands start in: personal, else family, else the external group's. */
export function primaryMountPoint(mounts: readonly SandboxRunnerMount[]): string {
  for (const point of ["personal", "family", "group"] as const) {
    if (mounts.some((mount) => mount.mountPoint === point)) return point;
  }
  throw new Error("AGENT_SANDBOX_RUNNER_SCOPE_INVALID: Sandbox has no workspace mount");
}

function toolsMount(
  runtime: SandboxDockerRuntime,
  mounts: readonly SandboxRunnerMount[],
): Docker.MountSettings {
  const mount = resolveTrustedToolMount(mounts);
  return volumeMount(runtime.toolsVolume, `/tools/${mount.mountPoint}`, mount.workspaceId);
}

function trustedEnvironment(mounts: readonly SandboxRunnerMount[]): string[] {
  const primary = resolveTrustedToolMount(mounts);
  const root = `/tools/${primary.mountPoint}`;
  const executablePaths = [`${root}/npm/bin`, `${root}/python/bin`, `${root}/bin`];
  return [
    // The reader (`--session osinara-reader --engine lightpanda`) stays here; the logged-in Chrome
    // and its restore state live in the browser companion.
    `AGENT_BROWSER_IDLE_TIMEOUT_MS=${AGENT_BROWSER_IDLE_TIMEOUT_MS}`,
    `AGENT_BROWSER_PROXY=${PROXY_URL}`,
    // Lightpanda reports usage to its vendor by default; a family sandbox reports nothing.
    "LIGHTPANDA_DISABLE_TELEMETRY=true",
    `HOME=${root}/home`,
    `PATH=${[...executablePaths, BASE_PATH].join(":")}`,
    `NPM_CONFIG_PREFIX=${root}/npm`,
    `NODE_EXTRA_CA_CERTS=${RUSSIAN_TRUSTED_ROOT_CA_PATH}`,
    "NODE_USE_ENV_PROXY=1",
    `PIP_CACHE_DIR=${root}/cache/pip`,
    `PLAYWRIGHT_BROWSERS_PATH=${root}/cache/ms-playwright`,
    `XDG_CACHE_HOME=${root}/cache`,
    `VIRTUAL_ENV=${root}/python`,
    `HTTP_PROXY=${PROXY_URL}`,
    `HTTPS_PROXY=${PROXY_URL}`,
    `http_proxy=${PROXY_URL}`,
    `https_proxy=${PROXY_URL}`,
    "NO_PROXY=localhost,127.0.0.1,sandbox-egress-proxy",
    "LANG=C.UTF-8",
  ];
}

function isolatedEnvironment(): string[] {
  return [
    "HOME=/tmp/home",
    `PATH=${BASE_PATH}`,
    "LANG=C.UTF-8",
  ];
}

export function buildSandboxContainerOptions(
  runtime: SandboxDockerRuntime,
  request: SandboxRunnerCreateRequest,
): Docker.ContainerCreateOptions {
  const trusted = request.access === "trusted";
  const mounts = workspaceMounts(runtime, request.mounts);
  if (trusted) {
    mounts.push(toolsMount(runtime, request.mounts));
  }

  return {
    AttachStderr: false,
    AttachStdin: false,
    AttachStdout: false,
    // The first process is named by absolute path with no image entrypoint: both used to be looked
    // up in the container PATH, whose head is the model's to write, before the firewall existed.
    Cmd: ["/usr/bin/sleep", "infinity"],
    Entrypoint: [""],
    Env: trusted ? trustedEnvironment(request.mounts) : isolatedEnvironment(),
    HostConfig: {
      AutoRemove: false,
      CapDrop: ["ALL"],
      // Docker's init process reaps Chromium descendants so durable sandboxes do not exhaust PIDs.
      Init: true,
      Memory: SANDBOX_MEMORY_BYTES,
      Mounts: mounts,
      NanoCpus: SANDBOX_CPU_NANOSECONDS,
      NetworkMode: trusted ? runtime.egressNetwork : "none",
      PidsLimit: SANDBOX_PIDS_LIMIT,
      Privileged: false,
      // Writable only through volumes and tmpfs: a write into the root would land in a layer on the
      // host disk outside every volume and the disk budget (port of ilkruglov e6283089).
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges:true"],
      ShmSize: SANDBOX_SHM_BYTES,
      // The shared image contains gws, but durable model-controlled Bash must never see it.
      Tmpfs: {
        "/opt/osinara": "ro,noexec,nosuid,size=64k,mode=0555",
        "/tmp": "rw,noexec,nosuid,size=512m,mode=1777",
        "/var/tmp": "rw,noexec,nosuid,size=64m,mode=1777",
      },
    },
    Image: runtime.image,
    Labels: {
      "dev.osinara.sandbox.access": request.access,
      "dev.osinara.sandbox.eve-session-id": request.eveSessionId,
      "dev.osinara.sandbox.policy-version": SANDBOX_CONTAINER_POLICY_VERSION,
      "dev.osinara.sandbox.project": runtime.project,
      "dev.osinara.sandbox.session-id": request.sandboxSessionId,
    },
    OpenStdin: false,
    StdinOnce: false,
    Tty: false,
    // `/workspace` itself is the read-only root holding the mount points; commands start in a
    // writable one.
    WorkingDir: `/workspace/${primaryMountPoint(request.mounts)}`,
  };
}

function browserEnvironment(): string[] {
  return [
    `AGENT_BROWSER_IDLE_TIMEOUT_MS=${AGENT_BROWSER_IDLE_TIMEOUT_MS}`,
    `AGENT_BROWSER_PROXY=${PROXY_URL}`,
    `AGENT_BROWSER_RESTORE=${AGENT_BROWSER_SESSION_NAME}`,
    `AGENT_BROWSER_RESTORE_SAVE=${AGENT_BROWSER_RESTORE_SAVE_POLICY}`,
    `AGENT_BROWSER_SESSION=${AGENT_BROWSER_SESSION_NAME}`,
    "LIGHTPANDA_DISABLE_TELEMETRY=true",
    `HOME=${BROWSER_STATE_TARGET}/home`,
    `PATH=${BASE_PATH}`,
    `NODE_EXTRA_CA_CERTS=${RUSSIAN_TRUSTED_ROOT_CA_PATH}`,
    "NODE_USE_ENV_PROXY=1",
    `XDG_CACHE_HOME=${BROWSER_STATE_TARGET}/cache`,
    `HTTP_PROXY=${PROXY_URL}`,
    `HTTPS_PROXY=${PROXY_URL}`,
    `http_proxy=${PROXY_URL}`,
    `https_proxy=${PROXY_URL}`,
    "NO_PROXY=localhost,127.0.0.1,sandbox-egress-proxy",
    "LANG=C.UTF-8",
  ];
}

/**
 * The browser companion: only its own state mount, no workspace (screenshots travel through the
 * application into the session's container) and its own network namespace, laid with the same
 * egress rules as the session's container.
 */
export function buildBrowserContainerOptions(
  runtime: SandboxDockerRuntime,
  input: {
    eveSessionId: string;
    parentContainerId: string;
    sandboxSessionId: string;
    toolsWorkspaceId: string;
  },
): Docker.ContainerCreateOptions {
  return {
    AttachStderr: false,
    AttachStdin: false,
    AttachStdout: false,
    Cmd: ["/usr/bin/sleep", "infinity"],
    Entrypoint: [""],
    Env: browserEnvironment(),
    HostConfig: {
      AutoRemove: false,
      CapDrop: ["ALL"],
      Init: true,
      Memory: SANDBOX_MEMORY_BYTES,
      Mounts: [volumeMount(runtime.toolsVolume, BROWSER_STATE_TARGET, browserStateSubpath(input.toolsWorkspaceId))],
      NanoCpus: SANDBOX_CPU_NANOSECONDS,
      NetworkMode: runtime.egressNetwork,
      PidsLimit: SANDBOX_PIDS_LIMIT,
      Privileged: false,
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges:true"],
      ShmSize: SANDBOX_SHM_BYTES,
      Tmpfs: {
        "/opt/osinara": "ro,noexec,nosuid,size=64k,mode=0555",
        "/tmp": "rw,noexec,nosuid,size=512m,mode=1777",
        "/var/tmp": "rw,noexec,nosuid,size=64m,mode=1777",
      },
    },
    Image: runtime.image,
    Labels: {
      "dev.osinara.sandbox.access": "trusted",
      "dev.osinara.sandbox.eve-session-id": input.eveSessionId,
      "dev.osinara.sandbox.policy-version": SANDBOX_CONTAINER_POLICY_VERSION,
      "dev.osinara.sandbox.project": runtime.project,
      [SANDBOX_PARENT_LABEL]: input.parentContainerId,
      [SANDBOX_ROLE_LABEL]: BROWSER_CONTAINER_ROLE,
      // The session label makes the capacity cap, idle stop and cleanup count this container with
      // its session; the session's own container is always looked up by name.
      "dev.osinara.sandbox.session-id": input.sandboxSessionId,
    },
    OpenStdin: false,
    StdinOnce: false,
    Tty: false,
    WorkingDir: BROWSER_STATE_TARGET,
  };
}

export function buildGoogleWorkspaceContainerOptions(
  runtime: SandboxDockerRuntime,
  request: GoogleWorkspaceExecutionRequest,
): Docker.ContainerCreateOptions {
  return {
    AttachStderr: true,
    AttachStdin: false,
    AttachStdout: true,
    Cmd: [GOOGLE_WORKSPACE_BINARY, ...request.argv],
    Env: [
      `GOOGLE_WORKSPACE_CLI_TOKEN=${request.accessToken}`,
      "HOME=/tmp",
      `HTTP_PROXY=${PROXY_URL}`,
      `HTTPS_PROXY=${PROXY_URL}`,
      "LANG=C.UTF-8",
      "NO_PROXY=localhost,127.0.0.1,sandbox-egress-proxy",
      `http_proxy=${PROXY_URL}`,
      `https_proxy=${PROXY_URL}`,
    ],
    HostConfig: {
      AutoRemove: false,
      CapDrop: ["ALL"],
      Init: true,
      Memory: SANDBOX_MEMORY_BYTES,
      Mounts: [volumeMount(runtime.workspaceVolume, "/workspace", request.workspaceId)],
      NanoCpus: SANDBOX_CPU_NANOSECONDS,
      NetworkMode: runtime.egressNetwork,
      PidsLimit: SANDBOX_PIDS_LIMIT,
      Privileged: false,
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m,mode=1777" },
    },
    Image: runtime.image,
    Labels: {
      "dev.osinara.google-workspace-execution": "true",
      "dev.osinara.sandbox.project": runtime.project,
    },
    OpenStdin: false,
    StdinOnce: false,
    Tty: false,
    WorkingDir: "/workspace",
  };
}
