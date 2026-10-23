/**
 * The egress firewall of a trusted sandbox, laid into its network namespace after every start.
 *
 * Exports:
 * - `EGRESS_PROXY_PORT`: the only port a sandbox may open a connection to.
 * - `buildFirewallScript`: the iptables script for one proxy address (pure, tested).
 * - `applyEgressFirewall`: runs the script in a short-lived helper with NET_ADMIN that joins the
 *   sandbox's namespace (`container:<id>`); the sandbox itself never has NET_ADMIN.
 * - `createEgressProxyResolver`: the proxy's address on the egress network, from Docker, cached.
 * - `createStartBarrier`: one application per container run and proxy address; every operation
 *   waits for it, and a failure removes the container (fail closed).
 *
 * Key constructs:
 * - Every trusted sandbox of every family sits on the one `sandbox-egress` bridge with
 *   inter-container traffic on, so a model's Bash could reach another family's sandbox directly;
 *   only the internet was policed, by the proxy (port of ilkruglov b6e3f289, 4d6f1ea3, 930e785a,
 *   ef80702b). The rules live in the namespace, so they need no host change and hold whatever
 *   the host's bridge settings are; a start or restart creates a new namespace, so they are laid
 *   again for every run.
 * - New outgoing TCP is allowed only to the proxy's address on port 3128, plus loopback (Docker's
 *   DNS at 127.0.0.11 is NAT-ed on `lo`) and replies; new incoming traffic is dropped. The address
 *   comes from the Docker API, never from DNS inside the namespace: the helper shares the
 *   sandbox's `/etc/hosts`, which the model can rewrite.
 * - The proxy's address changes when its container is recreated (a release), so it is part of the
 *   run's key: the next operation after the change lays the rules again with the new address.
 */
import { randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";

import type Docker from "dockerode";

import { containerGeneration } from "./docker-sandbox-container.js";

export const EGRESS_PROXY_PORT = 3128;
export const SANDBOX_FIREWALL_LABEL = "dev.osinara.sandbox.firewall";
const FIREWALL_TIMEOUT_MS = 30_000;
const PROXY_ADDRESS_TTL_MS = 15_000;
const PROXY_SERVICE = "sandbox-egress-proxy";
const MAX_TRACKED_RUNS = 2_000;
const SESSION_LABEL = "dev.osinara.sandbox.session-id";
const EVE_SESSION_LABEL = "dev.osinara.sandbox.eve-session-id";
const ACCESS_LABEL = "dev.osinara.sandbox.access";
const PROJECT_LABEL = "dev.osinara.sandbox.project";

/**
 * Idempotent: the chains are created once and flushed on every application, and the policies go
 * to DROP first, so a re-application on a running container is closed while the chains refill.
 */
export function buildFirewallScript(proxyAddress: string): string {
  if (!isIPv4(proxyAddress)) {
    throw new Error("AGENT_SANDBOX_RUNNER_EGRESS_PROXY_UNRESOLVED: Proxy address is not IPv4");
  }
  return [
    "set -e",
    // A namespace without IPv6 has no IPv6 path to police, and a kernel without ip6tables there
    // would otherwise remove every trusted sandbox; with IPv6 present a failure stays fatal.
    "v6=",
    "[ -e /proc/net/if_inet6 ] && v6=/usr/sbin/ip6tables",
    "for t in /usr/sbin/iptables $v6; do",
    "  $t -P OUTPUT DROP",
    "  $t -P INPUT DROP",
    "  $t -N OSINARA-OUT 2>/dev/null || $t -F OSINARA-OUT",
    "  $t -N OSINARA-IN 2>/dev/null || $t -F OSINARA-IN",
    "  $t -C OUTPUT -j OSINARA-OUT 2>/dev/null || $t -I OUTPUT -j OSINARA-OUT",
    "  $t -C INPUT -j OSINARA-IN 2>/dev/null || $t -I INPUT -j OSINARA-IN",
    "  $t -A OSINARA-OUT -o lo -j ACCEPT",
    "  $t -A OSINARA-OUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    "  $t -A OSINARA-IN -i lo -j ACCEPT",
    "  $t -A OSINARA-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    "  $t -A OSINARA-IN -j DROP",
    "done",
    `/usr/sbin/iptables -A OSINARA-OUT -p tcp -d ${proxyAddress} --dport ${EGRESS_PROXY_PORT} ` +
      "-m conntrack --ctstate NEW -j ACCEPT",
    "/usr/sbin/iptables -A OSINARA-OUT -j REJECT",
    '[ -z "$v6" ] || $v6 -A OSINARA-OUT -j REJECT',
  ].join("\n");
}

/** The sandbox's own address on the egress network, for the log that maps proxy lines to sessions. */
function sandboxAddress(inspection: Docker.ContainerInspectInfo, network: string): string {
  return inspection.NetworkSettings?.Networks?.[network]?.IPAddress ?? "";
}

export async function applyEgressFirewall(input: {
  container: Docker.Container;
  docker: Docker;
  egressNetwork: string;
  image: string;
  inspection: Docker.ContainerInspectInfo;
  project: string;
  proxyAddress: string;
}): Promise<void> {
  const script = buildFirewallScript(input.proxyAddress);
  const helper = await input.docker.createContainer({
    Cmd: ["/bin/sh", "-c", script],
    Entrypoint: [""],
    HostConfig: {
      AutoRemove: false,
      CapAdd: ["NET_ADMIN", "NET_RAW"],
      CapDrop: ["ALL"],
      NetworkMode: `container:${input.inspection.Id}`,
      Privileged: false,
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/run": "rw,noexec,nosuid,size=1m" },
    },
    Image: input.image,
    Labels: { [SANDBOX_FIREWALL_LABEL]: "true", [PROJECT_LABEL]: input.project },
    name: `osinara-sandbox-firewall-${randomUUID()}`,
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await helper.start();
    const result = await Promise.race([
      helper.wait() as Promise<{ StatusCode: number }>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          "AGENT_SANDBOX_RUNNER_FIREWALL_TIMED_OUT: Network rules were not applied in time",
        )), FIREWALL_TIMEOUT_MS);
      }),
    ]);
    if (result.StatusCode !== 0) {
      const logs = (await helper.logs({ stderr: true, stdout: true }) as Buffer)
        .toString("utf8").slice(-400);
      throw new Error(`AGENT_SANDBOX_RUNNER_FIREWALL_FAILED: ${logs}`);
    }
  } finally {
    clearTimeout(timer);
    await helper.remove({ force: true }).catch(() => undefined);
  }
  const labels = input.inspection.Config?.Labels ?? {};
  console.info(JSON.stringify({
    access: labels[ACCESS_LABEL],
    address: sandboxAddress(input.inspection, input.egressNetwork),
    code: "AGENT_SANDBOX_NETWORK_ATTACHED",
    container: input.inspection.Name?.replace(/^\//u, ""),
    eveSessionId: labels[EVE_SESSION_LABEL],
    proxyAddress: input.proxyAddress,
    sandboxSessionId: labels[SESSION_LABEL],
  }));
}

/** The proxy container's address on the egress network; exactly one container must answer. */
export function createEgressProxyResolver(input: {
  docker: Docker;
  egressNetwork: string;
  now: () => number;
  project: string;
}): () => Promise<string> {
  let cached: { address: string; at: number } | null = null;
  return async () => {
    if (cached && input.now() - cached.at < PROXY_ADDRESS_TTL_MS) return cached.address;
    const listed = await input.docker.listContainers({
      filters: {
        label: [
          `com.docker.compose.project=${input.project}`,
          `com.docker.compose.service=${PROXY_SERVICE}`,
        ],
        status: ["running"],
      },
    });
    const addresses = listed
      .map((item) => item.NetworkSettings?.Networks?.[input.egressNetwork]?.IPAddress ?? "")
      .filter((address) => isIPv4(address));
    if (addresses.length !== 1) {
      throw new Error(
        "AGENT_SANDBOX_RUNNER_EGRESS_PROXY_UNRESOLVED: " +
        `Expected one running egress proxy on ${input.egressNetwork}, found ${addresses.length}`,
      );
    }
    cached = { address: addresses[0]!, at: input.now() };
    return cached.address;
  };
}

/** A container that must not get a firewall: no network at all (external groups). */
function hasNoNetwork(inspection: Docker.ContainerInspectInfo): boolean {
  return inspection.HostConfig?.NetworkMode === "none";
}

/**
 * The container is `Running` the moment it starts, before its rules are laid: an operation of the
 * session arriving then would run without them. Every operation passes here with the run it
 * found; one run and proxy address is one application, shared by everyone who arrives while it
 * is laid. A failed application removes the container (its volumes stay), so the next call
 * creates or starts a new run and tries again; the failed run keeps its rejection meanwhile.
 */
export function createStartBarrier(input: {
  apply: (
    container: Docker.Container,
    inspection: Docker.ContainerInspectInfo,
    proxyAddress: string,
  ) => Promise<void>;
  resolveProxyAddress: () => Promise<string>;
}) {
  // Least recently used first; past the cap a settled run is forgotten, never one being laid.
  const runs = new Map<string, { key: string; ready: Promise<void>; settled: boolean }>();
  return async (container: Docker.Container, inspection: Docker.ContainerInspectInfo): Promise<void> => {
    if (hasNoNetwork(inspection)) return;
    const generation = containerGeneration(inspection);
    const proxyAddress = await input.resolveProxyAddress();
    const key = `${generation ?? ""} ${proxyAddress}`;
    const known = runs.get(inspection.Id);
    if (generation !== null && known?.key === key) {
      runs.delete(inspection.Id);
      runs.set(inspection.Id, known);
      return await known.ready;
    }
    const run = { key, ready: Promise.resolve(), settled: false };
    run.ready = input.apply(container, inspection, proxyAddress).catch(async (error: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_SANDBOX_RUNNER_FIREWALL_REMOVED_CONTAINER",
        container: inspection.Name?.replace(/^\//u, ""),
        error: error instanceof Error ? error.message.slice(0, 400) : String(error),
      }));
      await container.remove({ force: true, v: true }).catch(() => undefined);
      throw error;
    }).finally(() => {
      run.settled = true;
    });
    if (generation !== null) {
      runs.delete(inspection.Id);
      runs.set(inspection.Id, run);
      for (const [id, tracked] of runs) {
        if (runs.size <= MAX_TRACKED_RUNS) break;
        if (tracked.settled) runs.delete(id);
      }
    }
    return await run.ready;
  };
}
