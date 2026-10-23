/**
 * Workflow event log cache patch tests.
 *
 * Constructs covered:
 * - Resuming a run reuses the log it already read and fetches only the tail.
 * - Only a listing that reached the end of the log is stored for reuse, and each resume is traced.
 * - Every workflow pool query slower than the threshold names itself.
 * - The patched storage module and the installed cache stay syntactically valid.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const STORAGE_PATH = "node_modules/@workflow/world-postgres/dist/storage.js";
const CACHE_PATH = "node_modules/@workflow/world-postgres/dist/osinara-event-log-cache.js";
const execFileAsync = promisify(execFile);

describe("workflow event log cache patch", () => {
  it("reads a cached run log and extends it by the tail", async () => {
    const storage = await readFile(STORAGE_PATH, "utf8");

    // A 43-turn session carried 585 events and 9 MB of payloads that were re-read on every
    // message before the model was called (10 сентября 2026).
    expect(storage).toContain("const cacheKey = eventLogCacheKey(params, resolveData, sortOrder);");
    expect(storage).toContain("let cached = cacheKey === null ? undefined : readEventLogCache(cacheKey);");
    expect(storage).toContain("const data = cached === undefined ? [] : [...cached.data];");
    // A shrunk log must never be served from a stale prefix.
    expect(storage).toContain("if (total < cached.data.length) {");
    expect(storage).toContain("dropEventLogCache(cacheKey);");
    // Only a complete listing becomes a prefix for the next resume, and every resume reports itself.
    expect(storage).toContain("if (!hasMore) writeEventLogCache(cacheKey, data, data.at(-1)?.eventId);");
    expect(storage).toContain("traceEventLogRead(params.runId, reusedEvents,");
  });

  it("traces slow driver queries from the one pool the driver builds", async () => {
    const [index, trace] = await Promise.all([
      readFile("node_modules/@workflow/world-postgres/dist/index.js", "utf8"),
      readFile("node_modules/@workflow/world-postgres/dist/osinara-workflow-pool-trace.js", "utf8"),
    ]);

    expect(index).toContain("traceWorkflowPool(pool);");
    expect(trace).toContain("AGENT_WORKFLOW_SLOW_QUERY");
    // Parameter values carry the turn context of a family chat and never reach the log.
    expect(trace).toContain("statement: statementShape(args[0])");
  });

  it("installs the cache module next to the driver", async () => {
    const cache = await readFile(CACHE_PATH, "utf8");

    expect(cache).toContain("export function eventLogCacheKey");
    expect(cache).not.toMatch(/:\s*(string|number|boolean)\b/u);
  });

  it("keeps both patched modules syntactically valid", async () => {
    for (const path of [STORAGE_PATH, CACHE_PATH]) {
      await expect(execFileAsync(process.execPath, ["--check", path])).resolves.toMatchObject({
        stderr: "",
      });
    }
  });
});
