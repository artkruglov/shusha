/**
 * Isolated sandbox runner process entrypoint.
 *
 * Constructs:
 * - Connects exclusively to the mounted Docker socket.
 * - Discovers Compose-owned volumes/network and starts the private runner API.
 * - Wires the isolation: the running-container cap (`SANDBOX_MAX_RUNNING`), the egress firewall
 *   laid after every start, the stray-process sweep after every command, the 2 GiB disk
 *   budget per scope and 3 GiB that must stay free on the host disk.
 */
import Docker from "dockerode";

import {
  createDockerSandboxEngine,
  resolveSandboxDockerRuntime,
} from "./docker-sandbox-engine.js";
import { resolveSandboxMaxRunning } from "./docker-sandbox-capacity.js";
import {
  applyEgressFirewall,
  createEgressProxyResolver,
  createStartBarrier,
} from "./docker-sandbox-firewall.js";
import { SANDBOX_IDLE_SWEEP_INTERVAL_MS } from "./docker-sandbox-lifecycle.js";
import { killStrayProcesses } from "./docker-sandbox-strays.js";
import { createHostDiskProbe, createSandboxDiskQuota } from "./sandbox-disk-quota.js";
import { createSandboxRunnerServer } from "./server.js";

const RUNNER_PORT = 8080;
const DOCKER_SOCKET_PATH = "/var/run/docker.sock";

const docker = new Docker({ socketPath: DOCKER_SOCKET_PATH });
const maxRunning = resolveSandboxMaxRunning(process.env);
const resources = await resolveSandboxDockerRuntime(docker);
const { runtime } = resources;
const prepareRun = createStartBarrier({
  apply: async (container, inspection, proxyAddress) => await applyEgressFirewall({
    container,
    docker,
    egressNetwork: runtime.egressNetwork,
    image: runtime.image,
    inspection,
    project: runtime.project,
    proxyAddress,
  }),
  resolveProxyAddress: createEgressProxyResolver({
    docker,
    egressNetwork: runtime.egressNetwork,
    now: Date.now,
    project: runtime.project,
  }),
});
const engine = createDockerSandboxEngine({
  docker,
  hardening: {
    diskQuota: createSandboxDiskQuota({ now: Date.now, probe: createHostDiskProbe(resources.roots.workspaceRoot) }),
    maxRunning,
    prepareRun,
    sweepStrays: killStrayProcesses,
  },
  ...resources,
});
await engine.stopAllSessions();
await engine.health();

const server = createSandboxRunnerServer({ engine });
server.listen(RUNNER_PORT, "0.0.0.0", () => {
  console.log("Sandbox runner ready", { port: RUNNER_PORT });
});

// Stop idle compute for reuse, then remove expired/excess entries under an explicit hard bound.
const idleSweep = setInterval(() => {
  void engine.reconcileIdleSessions(new Date()).then(({ removed, stopped }) => {
    if (removed > 0 || stopped > 0) {
      console.log("Reconciled idle sandbox compute", { removed, stopped });
    }
  }, (error: unknown) => {
    console.error("Sandbox idle reconciliation failed", { error });
  });
}, SANDBOX_IDLE_SWEEP_INTERVAL_MS);
idleSweep.unref();

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(idleSweep);
  console.log("Sandbox runner stopping", { signal });
  await engine.stopAllSessions();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(() => process.exit(0), (error: unknown) => {
      console.error("Sandbox runner shutdown failed", { error, signal });
      process.exit(1);
    });
  });
}
