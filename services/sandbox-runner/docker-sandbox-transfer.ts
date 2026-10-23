/**
 * Moving bytes into and out of a sandbox through a process inside it.
 *
 * Exports:
 * - `writeContainerFile`: one file, written by `cat` from stdin and renamed into place.
 * - `readContainerFile`: one regular file through stdout, size-checked first; null when absent.
 * - `writeSeedFiles`: many files at once, one tar archive on stdin extracted by tar.
 *
 * Key constructs:
 * - The sandbox root is read-only, and Docker's archive API writes and reads only on volumes:
 *   neither the root nor a tmpfs such as a restricted HOME. The runner used a staging directory
 *   on the root and moved files from there, a window in which the model's Bash could replace a
 *   staged file. Here the bytes travel on the process's stdin and stdout; a write rests only in a
 *   temporary file beside its target, a place the model could write anyway (port of ilkruglov
 *   e6283089, c922345f, f9f3229f).
 * - The transfer tools are named by absolute path with the system PATH: the session's PATH starts
 *   with directories the model writes.
 * - Every step is bounded on the Node side too (exec, start, output, inspect): a stream that
 *   closes without `end` or never answers must not hold the session's creation gate forever.
 */
import { PassThrough, type Duplex } from "node:stream";

import type Docker from "dockerode";
import tar from "tar-stream";

import { WORKSPACE_MAX_FILE_BYTES } from "../../agent/config.js";
import type { SandboxRunnerSeedFile } from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import {
  FILE_MISSING_EXIT_CODE,
  FILE_MODE,
  FILE_TOO_LARGE_EXIT_CODE,
  READ_FILE_SCRIPT,
  WRITE_FILE_SCRIPT,
} from "./docker-sandbox-commands.js";
import { collectLimitedStream } from "./docker-sandbox-files.js";
import { SANDBOX_SYSTEM_PATH } from "./docker-sandbox-process.js";

const TRANSFER_TIMEOUT_SECONDS = 120;
/** Past the in-container timeout and its kill grace: the Node side gives up on the stream. */
const TRANSFER_DEADLINE_MS = (TRANSFER_TIMEOUT_SECONDS + 15) * 1_000;
const STDERR_MAX_BYTES = 64 * 1024;

interface TransferResult {
  exitCode: number;
  stderr: string;
  stdout: Buffer;
}

/** One process with optional stdin; stdout bounded, stderr kept short. */
async function runWithInput(
  docker: Docker,
  container: Docker.Container,
  argv: readonly string[],
  options: { maxStdoutBytes: number; stdin?: Buffer },
): Promise<TransferResult> {
  const deadline = Date.now() + TRANSFER_DEADLINE_MS;
  const within = <T>(promise: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("AGENT_SANDBOX_RUNNER_TRANSFER_TIMED_OUT: File transfer did not finish")),
        Math.max(0, deadline - Date.now()),
      );
    });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
  };
  const withInput = options.stdin !== undefined;
  const exec = await within(container.exec({
    AttachStderr: true,
    AttachStdin: withInput,
    AttachStdout: true,
    // TERM first, so the write program's trap removes its temporary file.
    Cmd: ["/usr/bin/timeout", "--signal=TERM", "--kill-after=5s", String(TRANSFER_TIMEOUT_SECONDS), ...argv],
    Env: [`PATH=${SANDBOX_SYSTEM_PATH}`],
    Tty: false,
    WorkingDir: "/",
  }));
  const stream = (await within(exec.start({ hijack: true, stdin: withInput, Tty: false }))) as Duplex;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("error", () => undefined);
  stderr.on("error", () => undefined);
  const finish = () => {
    stdout.end();
    stderr.end();
  };
  // A stream may close without `end` (a destroyed socket); either way the collectors finish.
  stream.once("end", finish);
  stream.once("close", finish);
  stream.once("error", (error) => {
    stdout.destroy(error);
    stderr.destroy(error);
  });
  try {
    docker.modem.demuxStream(stream, stdout, stderr);
    // The whole input at once, then the write side closed so the process sees end of file.
    if (withInput) stream.end(options.stdin);
    const [out, err] = await within(Promise.all([
      collectLimitedStream(stdout, options.maxStdoutBytes),
      collectLimitedStream(stderr, STDERR_MAX_BYTES).catch(() => Buffer.alloc(0)),
    ]));
    const inspection = await within(exec.inspect());
    if (inspection.Running || inspection.ExitCode === null) {
      throw new Error("AGENT_SANDBOX_RUNNER_TRANSFER_UNFINISHED: The transfer process did not exit");
    }
    return { exitCode: inspection.ExitCode, stderr: err.toString("utf8"), stdout: out };
  } finally {
    stream.destroy();
    stdout.destroy();
    stderr.destroy();
  }
}

export async function writeContainerFile(
  docker: Docker,
  container: Docker.Container,
  path: string,
  content: Uint8Array,
): Promise<void> {
  if (content.byteLength > WORKSPACE_MAX_FILE_BYTES) {
    throw new Error(
      `AGENT_SANDBOX_RUNNER_FILE_TOO_LARGE: Файл больше допустимых ${WORKSPACE_MAX_FILE_BYTES} байт`,
    );
  }
  const result = await runWithInput(
    docker,
    container,
    ["/bin/bash", "-c", WRITE_FILE_SCRIPT, "osinara-write", path],
    { maxStdoutBytes: STDERR_MAX_BYTES, stdin: Buffer.from(content) },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      "AGENT_SANDBOX_RUNNER_FILE_COMMIT_FAILED: " +
      `Не удалось записать файл в sandbox. ${result.stderr.slice(0, 400)}`,
    );
  }
}

/** The file's bytes; null when there is no regular file at `path`. */
export async function readContainerFile(
  docker: Docker,
  container: Docker.Container,
  path: string,
  maxBytes: number = WORKSPACE_MAX_FILE_BYTES,
): Promise<Uint8Array | null> {
  let result: TransferResult;
  try {
    result = await runWithInput(
      docker,
      container,
      ["/bin/bash", "-c", READ_FILE_SCRIPT, "osinara-read", path, String(Math.floor(maxBytes))],
      { maxStdoutBytes: maxBytes },
    );
  } catch (error) {
    // The file grew past the limit between the size check and the read.
    if (!(error instanceof Error) || !error.message.includes("AGENT_SANDBOX_RUNNER_OUTPUT_TOO_LARGE")) {
      throw error;
    }
    result = { exitCode: FILE_TOO_LARGE_EXIT_CODE, stderr: "", stdout: Buffer.alloc(0) };
  }
  if (result.exitCode === FILE_MISSING_EXIT_CODE) return null;
  if (result.exitCode === FILE_TOO_LARGE_EXIT_CODE) {
    throw new Error(`AGENT_SANDBOX_RUNNER_FILE_TOO_LARGE: Файл sandbox больше допустимых ${maxBytes} байт`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      "AGENT_SANDBOX_RUNNER_FILE_READ_FAILED: " +
      `Не удалось прочитать файл sandbox. ${result.stderr.slice(0, 400)}`,
    );
  }
  return new Uint8Array(result.stdout);
}

/** The seed as one tar of regular files (no directory entries: existing directories keep modes). */
async function seedArchive(files: readonly SandboxRunnerSeedFile[]): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
  });
  for (const file of files) {
    pack.entry(
      { mode: FILE_MODE, name: file.path.slice(1), type: "file" },
      Buffer.from(file.contentBase64, "base64"),
    );
  }
  pack.finalize();
  return await done;
}

export async function writeSeedFiles(
  docker: Docker,
  container: Docker.Container,
  files: readonly SandboxRunnerSeedFile[],
): Promise<void> {
  if (files.length === 0) return;
  const result = await runWithInput(docker, container, ["/usr/bin/tar", "-xpf", "-", "-C", "/"], {
    maxStdoutBytes: STDERR_MAX_BYTES,
    stdin: await seedArchive(files),
  });
  if (result.exitCode !== 0) {
    throw new Error(`AGENT_SANDBOX_RUNNER_SEED_FAILED: ${result.stderr.slice(0, 400)}`);
  }
}
