/**
 * Shell programs the runner executes inside a sandbox container, and their path safety.
 *
 * Exports:
 * - `shellQuote`: POSIX single-quote quoting; the shell expands nothing inside it.
 * - `assertShellSafePath`: control characters never reach a command or a log line.
 * - `READ_FILE_SCRIPT`, `WRITE_FILE_SCRIPT`: the file transfer programs; the path is their first
 *   positional argument (`$1`), so it is never part of the program text at all.
 * - `initializeToolEnvironmentCommand`: the tool environment's directories and Python venv.
 * - `FILE_MISSING_EXIT_CODE`, `FILE_TOO_LARGE_EXIT_CODE`: the existence and size checks run in
 *   the container before any byte is sent.
 *
 * Key constructs:
 * - Every path that does reach a program text sits inside single quotes. `JSON.stringify` used to
 *   be the quoting, and its double quotes leave `$(...)` and backticks live: a file name chosen by
 *   the model in an external group could run commands in the restricted container.
 * - A write lands in a temporary file in the target's own directory and is renamed into place, so
 *   the rename is atomic; `mv -T` makes a directory target fail instead of nesting the file. TERM
 *   from the transfer timeout runs the trap that removes the temporary file (port of ilkruglov
 *   c922345f, f9f3229f).
 */
export const FILE_MISSING_EXIT_CODE = 44;
export const FILE_TOO_LARGE_EXIT_CODE = 45;
export const FILE_MODE = 0o600;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export function assertShellSafePath(path: string): void {
  if (CONTROL_CHARACTERS.test(path)) {
    throw new Error("AGENT_SANDBOX_RUNNER_PATH_INVALID: Path contains control characters");
  }
}

export function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/** `$1` the file, `$2` the byte limit; prints the file on stdout after the checks. */
export const READ_FILE_SCRIPT = [
  "f=$1",
  `[ -f "$f" ] || exit ${FILE_MISSING_EXIT_CODE}`,
  // `wc -c` on a regular file asks its size; arithmetic drops the padding some wc print.
  `[ "$(( $(wc -c < "$f") ))" -le "$2" ] || exit ${FILE_TOO_LARGE_EXIT_CODE}`,
  "exec cat -- \"$f\"",
].join("\n");

/** `$1` the target; the bytes come on stdin. */
export const WRITE_FILE_SCRIPT = [
  "set -e",
  "target=$1",
  "dir=$(dirname -- \"$target\")",
  "mkdir -p -- \"$dir\"",
  "tmp=$(mktemp \"$dir/.osinara-write.XXXXXXXX\")",
  "trap 'rm -f -- \"$tmp\"' EXIT",
  "cat > \"$tmp\"",
  `chmod ${FILE_MODE.toString(8)} -- "$tmp"`,
  "mv -T -- \"$tmp\" \"$target\"",
  "trap - EXIT",
].join("\n");

export function initializeToolEnvironmentCommand(input: {
  directories: readonly string[];
  pythonRoot: string;
}): string {
  return [
    `mkdir -p ${input.directories.map(shellQuote).join(" ")}`,
    `(test -x ${shellQuote(`${input.pythonRoot}/bin/python`)} || python3 -m venv ${shellQuote(input.pythonRoot)})`,
  ].join(" && ");
}
