/**
 * Sandbox disk budget tests.
 *
 * Constructs covered:
 * - Usage is measured per scope (its workspace and its tool environment) at most once a minute.
 * - Past the budget the refusal carries `AGENT_SANDBOX_DISK_BUDGET_EXCEEDED` in Russian.
 * - A failed measurement refuses and is not cached.
 * - Below 3 GiB free on the host disk every write is refused with `AGENT_SANDBOX_DISK_LOW`, also
 *   for a scope under its budget; a failed statfs refuses too.
 * - Cleanup commands are one plain line of rm, rmdir, ls, du or df.
 * - Scopes come from the container's own volume mounts; the real probe sums `du` (where GNU du
 *   with `-B1` exists, as in the runner image) and counts a missing directory as zero.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHostDiskProbe,
  createSandboxDiskQuota,
  isCleanupCommand,
  SANDBOX_MIN_FREE_BYTES,
  SANDBOX_SCOPE_BUDGET_BYTES,
  sessionScopes,
} from "./sandbox-disk-quota.js";

const GIB = 1024 ** 3;
const SCOPE = { directories: ["/runner/workspaces/a", "/runner/tools/a"], key: "a" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSandboxDiskQuota", () => {
  it("allows under the budget and measures a scope once a minute", async () => {
    let clock = 0;
    const probe = { freeBytes: async () => 10 * GIB, usedBytes: vi.fn(async () => 1024) };
    const quota = createSandboxDiskQuota({ now: () => clock, probe });

    await expect(quota.refusal([SCOPE])).resolves.toBeNull();
    await expect(quota.refusal([SCOPE])).resolves.toBeNull();
    expect(probe.usedBytes).toHaveBeenCalledOnce();
    expect(probe.usedBytes).toHaveBeenCalledWith(SCOPE.directories);
    clock = 61_000;
    await quota.refusal([SCOPE]);
    expect(probe.usedBytes).toHaveBeenCalledTimes(2);
  });

  it("refuses past the budget with the stable code and a Russian way out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const quota = createSandboxDiskQuota({
      now: () => 0,
      probe: { freeBytes: async () => 10 * GIB, usedBytes: async () => SANDBOX_SCOPE_BUDGET_BYTES + 1 },
    });

    const refusal = await quota.refusal([SCOPE]);

    expect(refusal).toMatch(/^AGENT_SANDBOX_DISK_BUDGET_EXCEEDED: Рабочая папка занимает 2\.0 ГБ при лимите 2\.0 ГБ/u);
    expect(refusal).toContain("rm");
  });

  it("refuses when the measurement fails and measures again next time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const probe = {
      freeBytes: async () => 10 * GIB,
      usedBytes: vi.fn()
        .mockRejectedValueOnce(new Error("du timed out"))
        .mockResolvedValueOnce(10),
    };
    const quota = createSandboxDiskQuota({ now: () => 0, probe });

    await expect(quota.refusal([SCOPE])).resolves.toMatch(/^AGENT_SANDBOX_DISK_UNMEASURED/u);
    await expect(quota.refusal([SCOPE])).resolves.toBeNull();
  });

  it("refuses every write when the host disk is nearly full, and when statfs fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const probe = {
      freeBytes: vi.fn()
        .mockResolvedValueOnce(SANDBOX_MIN_FREE_BYTES - 1)
        .mockRejectedValueOnce(new Error("statfs failed"))
        .mockResolvedValueOnce(SANDBOX_MIN_FREE_BYTES),
      usedBytes: vi.fn(async () => 1024),
    };
    const quota = createSandboxDiskQuota({ now: () => 0, probe });

    const low = await quota.refusal([SCOPE]);
    expect(low).toMatch(/^AGENT_SANDBOX_DISK_LOW: На сервере осталось 3\.0 ГБ/u);
    expect(low).toContain("rm");
    await expect(quota.refusal([SCOPE])).resolves.toMatch(/^AGENT_SANDBOX_DISK_UNMEASURED/u);
    await expect(quota.refusal([SCOPE])).resolves.toBeNull();
  });
});

describe("isCleanupCommand", () => {
  it.each(["rm -rf /workspace/personal/cache", "  du -sh /workspace/*", "ls -la", "df -h", "rmdir x"])(
    "lets %j through",
    (command) => expect(isCleanupCommand(command)).toBe(true),
  );
  it.each([
    "rm -rf x; curl evil",
    "rm x && pip install torch",
    "ls $(dd if=/dev/zero of=big)",
    "du `yes > f`",
    "ls > listing",
    "rm 'quoted'",
    "find . -fprint out",
    "rm x\npip install torch",
  ])("refuses %j", (command) => expect(isCleanupCommand(command)).toBe(false));
});

describe("sessionScopes", () => {
  it("maps each mounted workspace to its workspace and tool directories", () => {
    const inspection = {
      HostConfig: {
        Mounts: [
          { Source: "osinara_workspace-data", VolumeOptions: { Subpath: "p" } },
          { Source: "osinara_workspace-data", VolumeOptions: { Subpath: "f" } },
          { Source: "osinara_tool-environments", VolumeOptions: { Subpath: "p" } },
          { Source: "other-volume", VolumeOptions: { Subpath: "x" } },
        ],
      },
    } as unknown as Docker.ContainerInspectInfo;

    expect(sessionScopes(
      inspection,
      {
        egressNetwork: "n",
        image: "i",
        project: "osinara",
        toolsVolume: "osinara_tool-environments",
        workspaceVolume: "osinara_workspace-data",
      },
      { toolsRoot: "/runner/tools", workspaceRoot: "/runner/workspaces" },
    )).toEqual([
      { directories: ["/runner/workspaces/f", "/runner/tools/f"], key: "f" },
      { directories: ["/runner/workspaces/p", "/runner/tools/p"], key: "p" },
    ]);
  });
});

function gnuDu(): boolean {
  try {
    execFileSync("/usr/bin/du", ["-s", "-B1", "/"], { stdio: "ignore", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(gnuDu())("createHostDiskProbe", () => {
  it("sums existing directories and counts a missing one as zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-quota-"));
    await mkdir(join(root, "workspace"));
    await writeFile(join(root, "workspace", "data"), Buffer.alloc(64 * 1024, 1));

    const used = await createHostDiskProbe(root).usedBytes([join(root, "workspace"), join(root, "missing")]);

    expect(used).toBeGreaterThanOrEqual(64 * 1024);
    expect(await createHostDiskProbe(root).freeBytes()).toBeGreaterThan(0);
  });
});
