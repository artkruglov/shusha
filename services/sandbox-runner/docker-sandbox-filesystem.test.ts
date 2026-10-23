/**
 * Docker sandbox filesystem bridge tests.
 *
 * Constructs covered:
 * - Reads run the read program with the path as `$1` and the limit as `$2`, return stdout, and
 *   map the existence and size exits; no archive API, no staging directory.
 * - Writes send the bytes on stdin of the write program; a failure surfaces its stderr.
 * - Seeds are one tar archive on stdin of the system tar, files only, mode 0600.
 * - Oversized writes are refused before any process starts.
 * - The disk budget refuses a write and a command, lets a cleanup command run with the system
 *   PATH, and lets a small skill package write into HOME pass.
 */
import { PassThrough } from "node:stream";

import type Docker from "dockerode";
import tar from "tar-stream";
import { describe, expect, it, vi } from "vitest";

import { WORKSPACE_MAX_FILE_BYTES } from "../../agent/config.js";
import { FILE_MISSING_EXIT_CODE, FILE_TOO_LARGE_EXIT_CODE } from "./docker-sandbox-commands.js";
import { createDockerSandboxEngine, type SandboxEngineHardening } from "./docker-sandbox-engine.js";
import { SANDBOX_SYSTEM_PATH } from "./docker-sandbox-process.js";
import { writeSeedFiles } from "./docker-sandbox-transfer.js";

const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERSONAL = "11111111-1111-4111-8111-111111111111";
const REFUSAL = "AGENT_SANDBOX_DISK_BUDGET_EXCEEDED: Рабочая папка занимает 2.5 ГБ при лимите 2.0 ГБ";

type ExecOptions = { Cmd: string[]; Env?: string[]; AttachStdin?: boolean };

const runtime = {
  egressNetwork: "osinara_sandbox-egress",
  image: "osinara-sandbox-runtime:local",
  project: "osinara",
  toolsVolume: "osinara_tool-environments",
  workspaceVolume: "osinara_workspace-data",
};

/** A container whose every exec prints `stdout`, exits with the next code and records stdin. */
function harness(exitCodes: number[], stdout = "") {
  const stdinChunks: Buffer[] = [];
  const container = {
    exec: vi.fn(async (_options: ExecOptions) => {
      const exitCode = exitCodes.length > 1 ? exitCodes.shift()! : exitCodes[0]!;
      const stream = new PassThrough();
      const end = stream.end.bind(stream);
      // The transfer closes its write side with the input; the stub records it and ends output.
      stream.end = ((chunk?: unknown) => {
        if (Buffer.isBuffer(chunk)) stdinChunks.push(chunk);
        return end();
      }) as typeof stream.end;
      return {
        inspect: vi.fn(async () => ({ ExitCode: exitCode, Running: false })),
        start: vi.fn(async (options: { stdin?: boolean }) => {
          if (!options.stdin) setImmediate(() => end());
          return stream;
        }),
      };
    }),
    inspect: vi.fn(async () => ({
      Config: { Labels: {} },
      HostConfig: {
        Mounts: [{ Source: runtime.workspaceVolume, VolumeOptions: { Subpath: PERSONAL } }],
        NetworkMode: runtime.egressNetwork,
      },
      Id: "container",
      State: { Running: true, StartedAt: "2026-10-08T10:00:00Z" },
    })),
    top: vi.fn(async () => ({ Processes: [] })),
  };
  const docker = {
    getContainer: vi.fn(() => container),
    modem: {
      demuxStream: vi.fn((stream: PassThrough, out: PassThrough, err: PassThrough) => {
        if (stdout) out.write(stdout);
        stream.on("end", () => {
          out.end();
          err.end();
        });
        stream.resume();
      }),
    },
  } as unknown as Docker;
  return { container, docker, stdinChunks };
}

function engineFor(docker: Docker, refusal: string | null = null) {
  const hardening: SandboxEngineHardening = {
    diskQuota: { refusal: async () => refusal },
    maxRunning: 10,
    prepareRun: async () => undefined,
    sweepStrays: async () => 0,
  };
  return createDockerSandboxEngine({
    docker,
    hardening,
    roots: { toolsRoot: "/tools", workspaceRoot: "/workspaces" },
    runtime,
  });
}

describe("Docker sandbox filesystem bridge", () => {
  it("reads through the read program's stdout with the path as an argument", async () => {
    const h = harness([0], "skill instructions");

    const content = await engineFor(h.docker).readFile(
      SANDBOX_SESSION_ID,
      "/tmp/home/.agents/skills/pohuy/SKILL.md",
    );

    expect(new TextDecoder().decode(content!)).toBe("skill instructions");
    const cmd = h.container.exec.mock.calls[0]![0].Cmd;
    expect(cmd.slice(0, 1)).toEqual(["/usr/bin/timeout"]);
    expect(cmd.slice(-3)).toEqual([
      "osinara-read",
      "/tmp/home/.agents/skills/pohuy/SKILL.md",
      String(WORKSPACE_MAX_FILE_BYTES),
    ]);
    expect(h.container.exec.mock.calls[0]![0].Env).toEqual([`PATH=${SANDBOX_SYSTEM_PATH}`]);
  });

  it("maps a missing file to null and an oversized one to a stable error", async () => {
    await expect(engineFor(harness([FILE_MISSING_EXIT_CODE]).docker)
      .readFile(SANDBOX_SESSION_ID, "/workspace/personal/absent")).resolves.toBeNull();
    await expect(engineFor(harness([FILE_TOO_LARGE_EXIT_CODE]).docker)
      .readFile(SANDBOX_SESSION_ID, "/workspace/personal/huge"))
      .rejects.toThrow(/AGENT_SANDBOX_RUNNER_FILE_TOO_LARGE/u);
  });

  it("writes the bytes on stdin of the write program", async () => {
    const h = harness([0]);

    await engineFor(h.docker).writeFile(
      SANDBOX_SESSION_ID,
      "/tmp/home/.agents/skills/pohuy/LICENSE.txt",
      new TextEncoder().encode("MIT"),
    );

    const options = h.container.exec.mock.calls[0]![0];
    expect(options.AttachStdin).toBe(true);
    expect(options.Cmd.slice(-2)).toEqual(["osinara-write", "/tmp/home/.agents/skills/pohuy/LICENSE.txt"]);
    expect(Buffer.concat(h.stdinChunks).toString()).toBe("MIT");
  });

  it("surfaces a refused write, such as a directory target", async () => {
    const h = harness([1]);

    await expect(engineFor(h.docker).writeFile(
      SANDBOX_SESSION_ID,
      "/tmp/home/.agents/skills/pohuy",
      new TextEncoder().encode("must-not-land-inside-directory"),
    )).rejects.toThrow(/AGENT_SANDBOX_RUNNER_FILE_COMMIT_FAILED: Не удалось записать файл/u);
  });

  it("refuses an oversized write before any process starts", async () => {
    const h = harness([0]);

    await expect(engineFor(h.docker).writeFile(
      SANDBOX_SESSION_ID,
      "/workspace/personal/big.bin",
      new Uint8Array(WORKSPACE_MAX_FILE_BYTES + 1),
    )).rejects.toThrow(/AGENT_SANDBOX_RUNNER_FILE_TOO_LARGE/u);
    expect(h.container.exec).not.toHaveBeenCalled();
  });

  it("extracts seeds from one private tar on stdin of the system tar", async () => {
    const h = harness([0]);

    await writeSeedFiles(h.docker, h.container as unknown as Docker.Container, [
      { contentBase64: Buffer.from("alpha").toString("base64"), path: "/workspace/a.txt" },
      { contentBase64: Buffer.from("beta").toString("base64"), path: "/tools/personal/b.txt" },
    ]);

    expect(h.container.exec.mock.calls[0]![0].Cmd.slice(-4)).toEqual(["-xpf", "-", "-C", "/"]);
    expect(h.container.exec.mock.calls[0]![0].Cmd).toContain("/usr/bin/tar");
    const entries: Array<{ content: string; mode: number | undefined; name: string; type: string }> = [];
    await new Promise<void>((resolve, reject) => {
      const extract = tar.extract();
      extract.on("entry", (header, stream, next) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          entries.push({
            content: Buffer.concat(chunks).toString(),
            mode: header.mode,
            name: header.name,
            type: header.type ?? "",
          });
          next();
        });
      });
      extract.on("finish", resolve);
      extract.on("error", reject);
      extract.end(Buffer.concat(h.stdinChunks));
    });
    expect(entries).toEqual([
      { content: "alpha", mode: 0o600, name: "workspace/a.txt", type: "file" },
      { content: "beta", mode: 0o600, name: "tools/personal/b.txt", type: "file" },
    ]);
  });

  it("refuses a write past the disk budget, but lets a small skill package into HOME pass", async () => {
    const h = harness([0]);
    const engine = engineFor(h.docker, REFUSAL);

    await expect(engine.writeFile(SANDBOX_SESSION_ID, "/workspace/personal/data.bin", new Uint8Array(10)))
      .rejects.toThrow(/^AGENT_SANDBOX_DISK_BUDGET_EXCEEDED/u);
    expect(h.container.exec).not.toHaveBeenCalled();
    await engine.writeFile(
      SANDBOX_SESSION_ID,
      "/tools/personal/home/.agents/skills/pohuy/SKILL.md",
      new TextEncoder().encode("# skill"),
    );
    expect(h.container.exec).toHaveBeenCalledOnce();
    await expect(engine.writeFile(
      SANDBOX_SESSION_ID,
      "/tools/personal/home/.agents/skills/pohuy/blob.bin",
      new Uint8Array(512 * 1024),
    )).rejects.toThrow(/^AGENT_SANDBOX_DISK_BUDGET_EXCEEDED/u);
  });

  it("answers a command past the budget with exit 125 and runs a cleanup command with the system PATH", async () => {
    const h = harness([0]);
    const engine = engineFor(h.docker, REFUSAL);

    const refused = await engine.runProcess(SANDBOX_SESSION_ID, { command: "pip install torch" });
    expect(refused).toMatchObject({ exitCode: 125, stderr: REFUSAL, stdout: "" });
    expect(h.container.exec).not.toHaveBeenCalled();

    const cleanup = await engine.runProcess(SANDBOX_SESSION_ID, {
      command: "rm -rf /workspace/personal/cache",
      environment: { PATH: "/tools/personal/bin:/usr/bin" },
    });
    expect(cleanup.exitCode).toBe(0);
    expect(h.container.exec.mock.calls[0]![0].Env).toContain(`PATH=${SANDBOX_SYSTEM_PATH}`);
  });
});
