/**
 * Bounded stream collection for sandbox processes and file transfer.
 *
 * Export:
 * - `collectLimitedStream`: reads a Docker stream without exceeding a caller-owned limit.
 */
import type { Readable } from "node:stream";

export async function collectLimitedStream(
  stream: Readable,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limit) {
      stream.destroy(new Error("AGENT_SANDBOX_RUNNER_OUTPUT_TOO_LARGE: Process output exceeds limit"));
      throw new Error("AGENT_SANDBOX_RUNNER_OUTPUT_TOO_LARGE: Process output exceeds limit");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}
