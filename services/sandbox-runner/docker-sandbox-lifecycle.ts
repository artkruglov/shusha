/**
 * Docker sandbox lifecycle identity and activity tracking.
 *
 * Exports:
 * - `SANDBOX_IDLE_SWEEP_INTERVAL_MS`: cadence for bounded idle reconciliation.
 * - `SANDBOX_IDLE_TIMEOUT_MS`: inactivity window before compute is stopped.
 * - `createSandboxActivityRegistry`: tracks active work and serializes session creation.
 * - `sandboxContainerName`: deterministic physical name for a stable conversation thread.
 * - `sandboxContainerNeedsReplacement`: detects stale owner or policy identity.
 * - `sandboxRequestHash`: stable policy identity independent of transient Eve roots.
 * - Activity gates prevent idle stop/removal from racing with newly arriving work.
 * - `runAlone` reuses that gate, so the stray-process sweep never meets a new command.
 */
import { createHash } from "node:crypto";

import type { SandboxRunnerCreateRequest } from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import { SANDBOX_CONTAINER_POLICY_VERSION } from "./docker-sandbox-options.js";

export const SANDBOX_IDLE_SWEEP_INTERVAL_MS = 60 * 1_000;
export const SANDBOX_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;

const CONTAINER_PREFIX = "osinara-sandbox-";

interface ExistingSandboxIdentity {
  requestHash: string | undefined;
  sandboxSessionId: string | undefined;
}

export interface SandboxActivityRegistry {
  /** Operations of the session currently inside `runActive`, the caller's own included. */
  activeCount(sessionId: string): number;
  clear(): void;
  forget(sessionId: string): void;
  isIdle(sessionId: string, cutoffMs: number): boolean;
  /** When the session last started or finished an operation; undefined when never seen. */
  lastActiveAt(sessionId: string): number | undefined;
  removeIfIdle(sessionId: string, cutoffMs: number, operation: () => Promise<void>): Promise<boolean>;
  runActive<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  /**
   * From inside `runActive`: runs `operation` only when the caller is the session's sole
   * operation, and holds new operations of the session until it ends. False when skipped.
   */
  runAlone(sessionId: string, operation: () => Promise<void>): Promise<boolean>;
  runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  touch(sessionId: string): void;
}

export function sandboxContainerName(sandboxSessionId: string): string {
  const id = createHash("sha256").update(sandboxSessionId).digest("hex").slice(0, 40);
  return `${CONTAINER_PREFIX}${id}`;
}

export function sandboxRequestHash(request: SandboxRunnerCreateRequest): string {
  // Mount ordering is not security-significant, while owner, access, and policy version are.
  const mounts = [...request.mounts].sort((left, right) =>
    `${left.mountPoint}:${left.workspaceId}`.localeCompare(`${right.mountPoint}:${right.workspaceId}`)
  );
  return createHash("sha256").update(JSON.stringify({
    access: request.access,
    mounts,
    policyVersion: SANDBOX_CONTAINER_POLICY_VERSION,
    sandboxSessionId: request.sandboxSessionId,
    seedDigest: request.seedDigest,
  })).digest("hex");
}

export function sandboxContainerNeedsReplacement(
  existing: ExistingSandboxIdentity,
  request: SandboxRunnerCreateRequest,
): boolean {
  return existing.sandboxSessionId !== request.sandboxSessionId ||
    existing.requestHash !== sandboxRequestHash(request);
}

export function createSandboxActivityRegistry(now: () => number): SandboxActivityRegistry {
  const activeCounts = new Map<string, number>();
  const creationLocks = new Map<string, Promise<void>>();
  const lastActivity = new Map<string, number>();
  const removalGates = new Map<string, Promise<void>>();
  const isIdle = (sessionId: string, cutoffMs: number): boolean => {
    if ((activeCounts.get(sessionId) ?? 0) > 0) return false;
    const lastUsedAt = lastActivity.get(sessionId);
    return lastUsedAt === undefined || lastUsedAt <= cutoffMs;
  };

  return {
    activeCount(sessionId) {
      return activeCounts.get(sessionId) ?? 0;
    },
    clear() {
      activeCounts.clear();
      creationLocks.clear();
      lastActivity.clear();
    },
    forget(sessionId) {
      activeCounts.delete(sessionId);
      lastActivity.delete(sessionId);
    },
    isIdle(sessionId, cutoffMs) {
      return isIdle(sessionId, cutoffMs);
    },
    lastActiveAt(sessionId) {
      return lastActivity.get(sessionId);
    },
    async runAlone(sessionId, operation) {
      // The stray sweep kills every process but the browser's; a command that started meanwhile
      // would lose its own, so the sweep runs only alone and new work waits for it.
      if ((activeCounts.get(sessionId) ?? 0) !== 1 || removalGates.has(sessionId)) return false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      removalGates.set(sessionId, gate);
      try {
        await operation();
        return true;
      } finally {
        if (removalGates.get(sessionId) === gate) removalGates.delete(sessionId);
        release();
      }
    },
    async runActive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
      // Register activity synchronously once no removal owns the ID, closing check/remove races.
      while (true) {
        const removal = removalGates.get(sessionId);
        if (removal) {
          await removal;
          continue;
        }
        activeCounts.set(sessionId, (activeCounts.get(sessionId) ?? 0) + 1);
        lastActivity.set(sessionId, now());
        break;
      }
      try {
        return await operation();
      } finally {
        const remaining = (activeCounts.get(sessionId) ?? 1) - 1;
        if (remaining === 0) activeCounts.delete(sessionId);
        else activeCounts.set(sessionId, remaining);
        lastActivity.set(sessionId, now());
      }
    },
    async removeIfIdle(sessionId, cutoffMs, operation) {
      // Reserve the physical ID before awaiting Docker; new work waits and recreates afterwards.
      while (true) {
        const pending = removalGates.get(sessionId);
        if (pending) {
          await pending;
          continue;
        }
        if (!isIdle(sessionId, cutoffMs)) return false;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        removalGates.set(sessionId, gate);
        let removed = false;
        try {
          await operation();
          removed = true;
          return true;
        } finally {
          if (removed) lastActivity.delete(sessionId);
          if (removalGates.get(sessionId) === gate) removalGates.delete(sessionId);
          release();
        }
      }
    },
    async runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
      // A non-rejecting tail preserves FIFO even when an earlier create operation fails.
      const predecessor = creationLocks.get(sessionId) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      creationLocks.set(sessionId, tail);
      await predecessor;
      try {
        return await operation();
      } finally {
        release();
        if (creationLocks.get(sessionId) === tail) creationLocks.delete(sessionId);
      }
    },
    touch(sessionId) {
      lastActivity.set(sessionId, now());
    },
  };
}
