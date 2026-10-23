/**
 * Disk budget of sandbox scopes, enforced by the runner before the model writes.
 *
 * Exports:
 * - `SANDBOX_SCOPE_BUDGET_BYTES`: 2 GiB per scope (its workspace plus its tool environment).
 * - `SANDBOX_MIN_FREE_BYTES`: 3 GiB that must stay free on the disk of the runner's volumes.
 * - `SANDBOX_DISK_REFUSED_EXIT_CODE`: exit status of a refused command.
 * - `isCleanupCommand`: a command that only frees or inspects space, allowed past the budget.
 * - `sessionScopes`: the scopes a container mounts, as directories under the runner's volumes.
 * - `createSandboxDiskQuota`: measured usage per scope, cached for a minute, and the refusal.
 * - `createHostDiskProbe`: `du` and `statfs` on the runner's own volume mounts.
 *
 * Key construct:
 * - The application writer limited single files, but the model's Bash writes straight into the
 *   workspace and tool volumes, which share the host disk with PostgreSQL (port of ilkruglov
 *   82693fd6 and its review fixes). Before a Bash command or a file write the runner measures
 *   `workspace-data/<id>` and `tool-environments/<id>` of every scope the container mounts, at
 *   most once a minute per scope; past 2 GiB, writes are refused with
 *   `AGENT_SANDBOX_DISK_BUDGET_EXCEEDED` and only commands that free space run. A failed
 *   measurement refuses too (fail closed). One command can still overshoot between measurements:
 *   this is the soft layer, not a filesystem quota.
 */
import { execFile } from "node:child_process";
import { stat, statfs } from "node:fs/promises";
import { promisify } from "node:util";

import type Docker from "dockerode";

import type { RuntimeRoots } from "./docker-sandbox-runtime.js";
import type { SandboxDockerRuntime } from "./docker-sandbox-options.js";

export const SANDBOX_SCOPE_BUDGET_BYTES = 2 * 1024 ** 3;
export const SANDBOX_MIN_FREE_BYTES = 3 * 1024 ** 3;
export const SANDBOX_DISK_REFUSED_EXIT_CODE = 125;
const MEASURE_TTL_MS = 60_000;
const MAX_CACHED_SCOPES = 2_000;
const GIB = 1024 ** 3;
const gib = (bytes: number) => (bytes / GIB).toFixed(1);

/**
 * `rm`, `rmdir`, `ls`, `du` or `df` alone on one line, with no quoting, chaining, redirection or
 * substitution: enough to see what takes space and delete it, and none of them writes. `find` is
 * not among them: its actions write files and quoting hides them from any pattern. The engine
 * runs these with the system PATH, so a binary planted under one of the names does not run.
 */
export function isCleanupCommand(command: string): boolean {
  return /^[ \t]*(?:rm|rmdir|ls|du|df)(?:[ \t][^;&|`$<>(){}'"\r\n\\]*)?$/u.test(command);
}

export interface DiskProbe {
  /** Bytes available to unprivileged writers on the filesystem of the runner's volumes. */
  freeBytes(): Promise<number>;
  /** Bytes allocated under the directories that exist; missing ones count zero. */
  usedBytes(directories: readonly string[]): Promise<number>;
}

export interface SandboxScope {
  directories: readonly string[];
  key: string;
}

export interface SandboxDiskQuota {
  /** The refusal text when a write must not happen, null when it may. */
  refusal(scopes: readonly SandboxScope[]): Promise<string | null>;
}

/** Every workspace the container mounts, with the tool environment of the same id. */
export function sessionScopes(
  inspection: Docker.ContainerInspectInfo,
  runtime: SandboxDockerRuntime,
  roots: RuntimeRoots,
): SandboxScope[] {
  const mounts = (inspection.HostConfig?.Mounts ?? []) as Array<{
    Source?: string;
    VolumeOptions?: { Subpath?: string };
  }>;
  const ids = new Set<string>();
  for (const mount of mounts) {
    const subpath = mount.VolumeOptions?.Subpath;
    if (subpath && (mount.Source === runtime.workspaceVolume || mount.Source === runtime.toolsVolume)) {
      ids.add(subpath);
    }
  }
  return [...ids].sort().map((id) => ({
    directories: [`${roots.workspaceRoot}/${id}`, `${roots.toolsRoot}/${id}`],
    key: id,
  }));
}

export function createSandboxDiskQuota(input: {
  limitBytes?: number;
  minFreeBytes?: number;
  now: () => number;
  probe: DiskProbe;
}): SandboxDiskQuota {
  const limit = input.limitBytes ?? SANDBOX_SCOPE_BUDGET_BYTES;
  const minFree = input.minFreeBytes ?? SANDBOX_MIN_FREE_BYTES;
  const measured = new Map<string, { at: number; bytes: number }>();
  const pending = new Map<string, Promise<number>>();

  /** Measured bytes; a failed measurement is not cached and refuses the write. */
  const usage = async (scope: SandboxScope): Promise<number> => {
    const cached = measured.get(scope.key);
    if (cached && input.now() - cached.at < MEASURE_TTL_MS) return cached.bytes;
    const running = pending.get(scope.key);
    if (running) return await running;
    const measuring = input.probe.usedBytes(scope.directories).then((bytes) => {
      measured.delete(scope.key);
      measured.set(scope.key, { at: input.now(), bytes });
      while (measured.size > MAX_CACHED_SCOPES) measured.delete(measured.keys().next().value!);
      return bytes;
    }).finally(() => pending.delete(scope.key));
    pending.set(scope.key, measuring);
    return await measuring;
  };

  const unmeasured = (error: unknown, scope: string) => {
    console.error(JSON.stringify({
      code: "AGENT_SANDBOX_DISK_UNMEASURED",
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      scope,
    }));
    return "AGENT_SANDBOX_DISK_UNMEASURED: Не удалось измерить, сколько места занимает рабочая " +
      "папка, запись остановлена. Удалите ненужные файлы командой rm или повторите позже.";
  };

  return {
    async refusal(scopes) {
      let free: number;
      try {
        free = await input.probe.freeBytes();
      } catch (error) {
        return unmeasured(error, "host");
      }
      if (free < minFree) {
        console.error(JSON.stringify({ code: "AGENT_SANDBOX_DISK_LOW", freeBytes: free, minFreeBytes: minFree }));
        return `AGENT_SANDBOX_DISK_LOW: На сервере осталось ${gib(free)} ГБ свободного места, запись ` +
          "остановлена, чтобы не задеть базу данных. Удалите ненужные файлы из рабочей папки командой rm " +
          "(посмотреть размеры: du -sh /workspace/* /tools/*) или скажите человеку, что место кончается.";
      }
      for (const scope of scopes) {
        let used: number;
        try {
          used = await usage(scope);
        } catch (error) {
          return unmeasured(error, scope.key);
        }
        if (used > limit) {
          console.error(JSON.stringify({
            code: "AGENT_SANDBOX_DISK_BUDGET_EXCEEDED",
            limitBytes: limit,
            scope: scope.key,
            usedBytes: used,
          }));
          return "AGENT_SANDBOX_DISK_BUDGET_EXCEEDED: Рабочая папка занимает " +
            `${gib(used)} ГБ при лимите ${gib(limit)} ГБ, запись остановлена. Посмотрите, что занимает ` +
            "место (du -sh /workspace/* /tools/*), удалите ненужное командой rm и только потом продолжайте.";
        }
      }
      return null;
    },
  };
}

const execFileAsync = promisify(execFile);

/**
 * `du` over the runner's volume mounts (allocated blocks, so preallocated files count in full) and
 * `statfs` on `volumeRoot` for the free space of the filesystem they live on.
 */
export function createHostDiskProbe(volumeRoot: string): DiskProbe {
  return {
    async freeBytes() {
      const stats = await statfs(volumeRoot);
      return stats.bavail * stats.bsize;
    },
    async usedBytes(directories) {
      // Only a missing directory counts zero; any other failure of du is an error, never zero.
      const existing: string[] = [];
      for (const directory of directories) {
        try {
          if ((await stat(directory)).isDirectory()) existing.push(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (existing.length === 0) return 0;
      const { stdout } = await execFileAsync("/usr/bin/du", ["-s", "-B1", "--", ...existing], {
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
      });
      const sizes = stdout.trim().split("\n").map((line) => Number(line.split("\t", 1)[0]));
      if (sizes.length !== existing.length || sizes.some((size) => !Number.isSafeInteger(size) || size < 0)) {
        throw new Error(
          `AGENT_SANDBOX_DISK_UNMEASURED: du printed ${sizes.length} sizes for ${existing.length} directories`,
        );
      }
      return sizes.reduce((total, size) => total + size, 0);
    },
  };
}
