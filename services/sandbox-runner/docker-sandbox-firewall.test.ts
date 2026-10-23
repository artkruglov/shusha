/**
 * Sandbox egress firewall tests.
 *
 * Constructs covered:
 * - The rules allow new TCP only to the proxy's address and port, loopback and replies; DROP
 *   policies come before the chains are refilled; a non-IPv4 address is refused.
 * - The helper joins the sandbox's namespace with NET_ADMIN, a failure is surfaced with its logs
 *   and the helper is removed either way; the attachment is logged with the session.
 * - The proxy address comes from Docker and exactly one proxy must answer.
 * - The start barrier applies once per run and proxy address, re-applies for a new run or a
 *   new proxy address, skips network-less containers, and removes the container on failure.
 */
import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyEgressFirewall,
  buildFirewallScript,
  createEgressProxyResolver,
  createStartBarrier,
} from "./docker-sandbox-firewall.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function inspection(overrides: Partial<{ id: string; network: string; startedAt: string }> = {}) {
  return {
    Config: {
      Labels: {
        "dev.osinara.sandbox.access": "trusted",
        "dev.osinara.sandbox.eve-session-id": "wrun_01JZ8K4R0W6G73VTHX9NF2QABC",
        "dev.osinara.sandbox.session-id": "session-a",
      },
    },
    HostConfig: { NetworkMode: overrides.network ?? "osinara_sandbox-egress" },
    Id: overrides.id ?? "container-a",
    Name: "/osinara-sandbox-a",
    NetworkSettings: { Networks: { "osinara_sandbox-egress": { IPAddress: "172.30.0.9" } } },
    State: { Running: true, StartedAt: overrides.startedAt ?? "2026-10-08T10:00:00Z" },
  } as unknown as Docker.ContainerInspectInfo;
}

describe("buildFirewallScript", () => {
  it("opens only the proxy port on the proxy address and closes before refilling", () => {
    const script = buildFirewallScript("172.30.0.2");
    const lines = script.split("\n");

    expect(script).toContain(
      "/usr/sbin/iptables -A OSINARA-OUT -p tcp -d 172.30.0.2 --dport 3128 -m conntrack --ctstate NEW -j ACCEPT",
    );
    expect(lines.findIndex((line) => line.includes("-P OUTPUT DROP")))
      .toBeLessThan(lines.findIndex((line) => line.includes("-F OSINARA-OUT")));
    expect(script).toContain("-A OSINARA-OUT -o lo -j ACCEPT");
    expect(script).toContain("-A OSINARA-IN -j DROP");
    expect(lines.at(-2)).toBe("/usr/sbin/iptables -A OSINARA-OUT -j REJECT");
    // IPv6 is policed only where the namespace has it; there a missing ip6tables stays fatal.
    expect(script).toContain("[ -e /proc/net/if_inet6 ] && v6=/usr/sbin/ip6tables");
    expect(script).toContain('[ -z "$v6" ] || $v6 -A OSINARA-OUT -j REJECT');
    // Exactly one ACCEPT for new traffic leaving the namespace.
    expect(script.match(/ctstate NEW -j ACCEPT/gu)).toHaveLength(1);
  });

  it.each(["", "sandbox-egress-proxy", "172.30.0.2; reboot", "::1"])("refuses %j as the proxy address", (address) => {
    expect(() => buildFirewallScript(address)).toThrow("AGENT_SANDBOX_RUNNER_EGRESS_PROXY_UNRESOLVED");
  });
});

describe("applyEgressFirewall", () => {
  function dockerWithHelper(statusCode: number) {
    const helper = {
      logs: vi.fn(async () => Buffer.from("iptables: Permission denied")),
      remove: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      wait: vi.fn(async () => ({ StatusCode: statusCode })),
    };
    const docker = { createContainer: vi.fn(async () => helper) } as unknown as Docker;
    return { docker, helper };
  }

  it("runs the rules in the sandbox's namespace and logs the attachment", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { docker, helper } = dockerWithHelper(0);

    await applyEgressFirewall({
      container: {} as Docker.Container,
      docker,
      egressNetwork: "osinara_sandbox-egress",
      image: "osinara-sandbox-runtime:local",
      inspection: inspection(),
      project: "osinara",
      proxyAddress: "172.30.0.2",
    });

    expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      Entrypoint: [""],
      HostConfig: expect.objectContaining({
        CapAdd: ["NET_ADMIN", "NET_RAW"],
        CapDrop: ["ALL"],
        NetworkMode: "container:container-a",
        Privileged: false,
      }),
      Image: "osinara-sandbox-runtime:local",
    }));
    expect(helper.remove).toHaveBeenCalledWith({ force: true });
    const line = JSON.parse(String(info.mock.calls[0]![0]));
    expect(line).toMatchObject({
      address: "172.30.0.9",
      code: "AGENT_SANDBOX_NETWORK_ATTACHED",
      proxyAddress: "172.30.0.2",
      sandboxSessionId: "session-a",
    });
  });

  it("fails with the helper's output and still removes the helper", async () => {
    const { docker, helper } = dockerWithHelper(4);

    await expect(applyEgressFirewall({
      container: {} as Docker.Container,
      docker,
      egressNetwork: "osinara_sandbox-egress",
      image: "osinara-sandbox-runtime:local",
      inspection: inspection(),
      project: "osinara",
      proxyAddress: "172.30.0.2",
    })).rejects.toThrow(/AGENT_SANDBOX_RUNNER_FIREWALL_FAILED: iptables: Permission denied/u);
    expect(helper.remove).toHaveBeenCalledOnce();
  });
});

describe("createEgressProxyResolver", () => {
  function dockerListing(addresses: string[]) {
    return {
      listContainers: vi.fn(async () => addresses.map((address) => ({
        NetworkSettings: { Networks: { "osinara_sandbox-egress": { IPAddress: address } } },
      }))),
    } as unknown as Docker;
  }

  it("asks Docker for the compose proxy and caches the answer briefly", async () => {
    const docker = dockerListing(["172.30.0.2"]);
    let clock = 0;
    const resolve = createEgressProxyResolver({
      docker,
      egressNetwork: "osinara_sandbox-egress",
      now: () => clock,
      project: "osinara",
    });

    expect(await resolve()).toBe("172.30.0.2");
    expect(await resolve()).toBe("172.30.0.2");
    expect(docker.listContainers).toHaveBeenCalledOnce();
    expect(docker.listContainers).toHaveBeenCalledWith({
      filters: {
        label: ["com.docker.compose.project=osinara", "com.docker.compose.service=sandbox-egress-proxy"],
        status: ["running"],
      },
    });
    clock = 60_000;
    await resolve();
    expect(docker.listContainers).toHaveBeenCalledTimes(2);
  });

  it.each([[[]], [["172.30.0.2", "172.30.0.3"]]])("refuses %j proxies", async (addresses) => {
    const resolve = createEgressProxyResolver({
      docker: dockerListing(addresses),
      egressNetwork: "osinara_sandbox-egress",
      now: () => 0,
      project: "osinara",
    });

    await expect(resolve()).rejects.toThrow("AGENT_SANDBOX_RUNNER_EGRESS_PROXY_UNRESOLVED");
  });
});

describe("createStartBarrier", () => {
  it("applies once per run and again for a new run or a new proxy address", async () => {
    let proxy = "172.30.0.2";
    const apply = vi.fn(async () => undefined);
    const barrier = createStartBarrier({ apply, resolveProxyAddress: async () => proxy });
    const container = { remove: vi.fn() } as unknown as Docker.Container;

    await Promise.all([barrier(container, inspection()), barrier(container, inspection())]);
    expect(apply).toHaveBeenCalledOnce();
    await barrier(container, inspection({ startedAt: "2026-10-08T11:00:00Z" }));
    expect(apply).toHaveBeenCalledTimes(2);
    proxy = "172.30.0.5";
    await barrier(container, inspection({ startedAt: "2026-10-08T11:00:00Z" }));
    expect(apply).toHaveBeenCalledTimes(3);
    expect(apply).toHaveBeenLastCalledWith(container, expect.anything(), "172.30.0.5");
  });

  it("skips a container without a network and never asks for the proxy", async () => {
    const apply = vi.fn(async () => undefined);
    const resolveProxyAddress = vi.fn(async () => "172.30.0.2");
    const barrier = createStartBarrier({ apply, resolveProxyAddress });

    await barrier({} as Docker.Container, inspection({ network: "none" }));

    expect(apply).not.toHaveBeenCalled();
    expect(resolveProxyAddress).not.toHaveBeenCalled();
  });

  it("removes the container when its rules fail, and every waiter fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const apply = vi.fn(async () => {
      throw new Error("AGENT_SANDBOX_RUNNER_FIREWALL_FAILED: no nf_tables");
    });
    const barrier = createStartBarrier({ apply, resolveProxyAddress: async () => "172.30.0.2" });
    const remove = vi.fn(async () => undefined);
    const container = { remove } as unknown as Docker.Container;

    const results = await Promise.allSettled([
      barrier(container, inspection()),
      barrier(container, inspection()),
    ]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(remove).toHaveBeenCalledWith({ force: true, v: true });
    // The failed run keeps its rejection: a later operation on it does not lay a second set.
    await expect(barrier(container, inspection())).rejects.toThrow("AGENT_SANDBOX_RUNNER_FIREWALL_FAILED");
    expect(apply).toHaveBeenCalledOnce();
  });
});
