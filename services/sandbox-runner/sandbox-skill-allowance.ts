/**
 * Skill package writes that pass a disk-budget refusal.
 *
 * Export:
 * - `createSkillWriteAllowance`: small writes into HOME's skills folder, bounded per container run.
 *
 * Key construct:
 * - Eve materializes skill packages into the sandbox's HOME through file writes on every turn;
 *   refusing them would end every turn of a workspace that is over budget, so the model could
 *   not even run `rm` to free space. The path alone does not prove Eve wrote the file, so only
 *   files up to 256 KiB and 2 MiB per container run pass (port of ilkruglov e6283089, c922345f).
 */
import type Docker from "dockerode";

import { containerGeneration } from "./docker-sandbox-container.js";

const FILE_EXEMPT_BYTES = 256 * 1024;
const RUN_EXEMPT_BYTES = 2 * 1024 * 1024;
const MAX_TRACKED_RUNS = 1_000;
const HOME_SKILLS_PATH = /^(?:\/tools\/(?:personal|family)\/home|\/tmp\/home)\/\.agents\/skills\/[^/]/u;

export function createSkillWriteAllowance() {
  const spentByRun = new Map<string, number>();
  return {
    allows(inspection: Docker.ContainerInspectInfo, path: string, bytes: number): boolean {
      const generation = containerGeneration(inspection);
      if (generation === null || !HOME_SKILLS_PATH.test(path) || path.includes("/../")) return false;
      if (bytes > FILE_EXEMPT_BYTES) return false;
      const spent = (spentByRun.get(generation) ?? 0) + bytes;
      if (spent > RUN_EXEMPT_BYTES) return false;
      if (spentByRun.size >= MAX_TRACKED_RUNS && !spentByRun.has(generation)) spentByRun.clear();
      spentByRun.set(generation, spent);
      return true;
    },
  };
}
