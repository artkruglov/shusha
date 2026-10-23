/**
 * Compose-owned Docker resources the sandbox runner works with.
 *
 * Exports:
 * - `RuntimeRoots`: where the runner itself sees the workspace and tool volumes.
 * - `resolveSandboxRuntimeImage`: requires the exact sandbox runtime image identity.
 * - `resolveSandboxDockerRuntime`: discovers Compose-owned volumes/network fail-fast.
 */
import type Docker from "dockerode";

import type { SandboxDockerRuntime } from "./docker-sandbox-options.js";

const MOUNT_TOOLS_DESTINATION = "/runner/tools";
const MOUNT_WORKSPACES_DESTINATION = "/runner/workspaces";
const SANDBOX_NETWORK_LABEL = "sandbox-egress";

interface RunnerMount {
  Destination?: string;
  Name?: string;
}

export interface RuntimeRoots {
  toolsRoot: string;
  workspaceRoot: string;
}

export function resolveSandboxRuntimeImage(): string {
  const image = process.env.SANDBOX_RUNTIME_IMAGE;
  if (!image) {
    throw new Error(
      "AGENT_SANDBOX_RUNTIME_IMAGE_MISSING: Не задан обязательный образ sandbox runtime",
    );
  }
  return image;
}

export async function resolveSandboxDockerRuntime(docker: Docker): Promise<{
  roots: RuntimeRoots;
  runtime: SandboxDockerRuntime;
}> {
  // Configuration is validated before any Docker call so startup fails with one stable diagnosis.
  const image = resolveSandboxRuntimeImage();
  const runnerId = process.env.HOSTNAME;
  if (!runnerId) throw new Error("AGENT_SANDBOX_RUNNER_HOSTNAME_MISSING: Container ID is required");
  const inspection = await docker.getContainer(runnerId).inspect();
  const mounts = inspection.Mounts as RunnerMount[];
  const workspaceVolume = mounts.find((mount) => mount.Destination === MOUNT_WORKSPACES_DESTINATION)?.Name;
  const toolsVolume = mounts.find((mount) => mount.Destination === MOUNT_TOOLS_DESTINATION)?.Name;
  if (!workspaceVolume || !toolsVolume) {
    throw new Error("AGENT_SANDBOX_RUNNER_VOLUME_MISSING: Compose volumes are not mounted");
  }

  const composeProject = inspection.Config.Labels?.["com.docker.compose.project"];
  if (!composeProject) {
    throw new Error("AGENT_SANDBOX_RUNNER_PROJECT_MISSING: Compose project label is absent");
  }
  const networks = await docker.listNetworks({
    filters: {
      label: [
        `com.docker.compose.network=${SANDBOX_NETWORK_LABEL}`,
        `com.docker.compose.project=${composeProject}`,
      ],
    },
  });
  const egressNetwork = networks.length === 1 ? networks[0]!.Name : null;
  if (!egressNetwork) {
    throw new Error("AGENT_SANDBOX_RUNNER_NETWORK_MISSING: Egress network is not uniquely resolved");
  }

  return {
    roots: {
      toolsRoot: MOUNT_TOOLS_DESTINATION,
      workspaceRoot: MOUNT_WORKSPACES_DESTINATION,
    },
    runtime: {
      egressNetwork,
      image,
      project: composeProject,
      toolsVolume,
      workspaceVolume,
    },
  };
}
