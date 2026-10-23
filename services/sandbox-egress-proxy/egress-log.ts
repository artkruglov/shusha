/**
 * One log line per allowed sandbox connection and a daily byte budget per sandbox.
 *
 * Exports:
 * - `createEgressMeter`: counts the bytes of one connection and logs it once, when it ends.
 * - `createEgressBudget`: one byte total per client address and UTC day.
 * - `egressDailyBytesFromEnv`: the budget from `SANDBOX_EGRESS_DAILY_BYTES`, 2 GiB by default.
 *
 * Key construct:
 * - The proxy used to log only refusals, so nothing showed what a sandbox actually reached or how
 *   much it moved (port of the egress log of ilkruglov b6e3f289). Each allowed connection ends in
 *   one JSON line `AGENT_SANDBOX_EGRESS` with the client address, the destination, bytes each way
 *   and the duration; the runner logs `AGENT_SANDBOX_NETWORK_ATTACHED` with the same address and
 *   the sandbox session, so a line maps to a session. Counters are attached together with the
 *   pipes they observe: a `data` listener attached earlier would drain a request body before the
 *   pipe exists (a bug upstream fixed in 4d6f1ea3).
 */
import type { Readable } from "node:stream";

export const SANDBOX_EGRESS_DAILY_BYTES = 2 * 1024 ** 3;
const MAX_TRACKED_CLIENTS = 5_000;

export interface EgressBudget {
  /** False once the client spent its budget for the current UTC day. */
  admit(client: string | undefined): boolean;
  /** Adds bytes to the client's day; false once the total reaches the budget. */
  spend(client: string | undefined, bytes: number): boolean;
}

function clientAddress(client: string | undefined): string {
  return (client ?? "").replace(/^::ffff:/u, "");
}

export function egressDailyBytesFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.SANDBOX_EGRESS_DAILY_BYTES;
  if (raw === undefined || raw === "") return SANDBOX_EGRESS_DAILY_BYTES;
  const bytes = Number(raw);
  if (!/^[0-9]+$/u.test(raw) || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error("AGENT_SANDBOX_EGRESS_CONFIG_INVALID: SANDBOX_EGRESS_DAILY_BYTES must be a positive integer of bytes");
  }
  return bytes;
}

export function createEgressBudget(input: {
  dailyBytes: number;
  log?: (line: string) => void;
  now?: () => number;
}): EgressBudget {
  const now = input.now ?? Date.now;
  const log = input.log ?? ((line: string) => console.info(line));
  const days = new Map<string, { bytes: number; day: number }>();
  const today = () => Math.floor(now() / 86_400_000);
  const spent = (client: string) => {
    const entry = days.get(client);
    return entry && entry.day === today() ? entry.bytes : 0;
  };
  const refuse = (client: string) => log(JSON.stringify({
    client,
    code: "AGENT_SANDBOX_EGRESS_DAILY_LIMIT",
    dailyBytes: input.dailyBytes,
  }));
  return {
    admit(rawClient) {
      const client = clientAddress(rawClient);
      if (spent(client) < input.dailyBytes) return true;
      refuse(client);
      return false;
    },
    spend(rawClient, bytes) {
      const client = clientAddress(rawClient);
      const before = spent(client);
      const total = before + bytes;
      // Re-inserted, so the first entry is always the least recently active client.
      days.delete(client);
      days.set(client, { bytes: total, day: today() });
      while (days.size > MAX_TRACKED_CLIENTS) days.delete(days.keys().next().value!);
      if (total < input.dailyBytes) return true;
      if (before < input.dailyBytes) refuse(client);
      return false;
    },
  };
}

export interface EgressMeter {
  /** Counts what flows from the sandbox to the destination. */
  countOut(stream: Readable, initialBytes?: number): void;
  /** Counts what flows from the destination back to the sandbox. */
  countIn(stream: Readable): void;
  /** Logs the connection once; later calls do nothing. */
  finish(outcome: { status?: number }): void;
}

export function createEgressMeter(input: {
  budget?: EgressBudget;
  client: string | undefined;
  host: string;
  kind: "connect" | "http";
  log?: (line: string) => void;
  now?: () => number;
  /** Called once when this connection's bytes cross the client's daily budget. */
  onOverBudget?: () => void;
  port: number;
}): EgressMeter {
  const now = input.now ?? Date.now;
  const log = input.log ?? ((line: string) => console.info(line));
  const startedAt = now();
  let bytesIn = 0;
  let bytesOut = 0;
  let finished = false;
  let over = false;
  const spend = (bytes: number) => {
    if (!input.budget || over || input.budget.spend(input.client, bytes)) return;
    over = true;
    input.onOverBudget?.();
  };
  const size = (chunk: Buffer | string) => typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
  return {
    countOut(stream, initialBytes = 0) {
      bytesOut += initialBytes;
      spend(initialBytes);
      stream.on("data", (chunk: Buffer | string) => {
        bytesOut += size(chunk);
        spend(size(chunk));
      });
    },
    countIn(stream) {
      stream.on("data", (chunk: Buffer | string) => {
        bytesIn += size(chunk);
        spend(size(chunk));
      });
    },
    finish(outcome) {
      if (finished) return;
      finished = true;
      log(JSON.stringify({
        bytesIn,
        bytesOut,
        client: clientAddress(input.client),
        code: "AGENT_SANDBOX_EGRESS",
        durationMs: now() - startedAt,
        host: input.host,
        kind: input.kind,
        port: input.port,
        ...(outcome.status === undefined ? {} : { status: outcome.status }),
      }));
    },
  };
}
