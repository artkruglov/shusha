/**
 * Version-pinned seams: the Workflow event log stores each turn once and smaller.
 *
 * Three changes to `@workflow/world-postgres` storage, ported from Osinara 1.8.18–1.8.20
 * (ilkruglov 0da9b86, b9b5ece, 63189f5, e93d9ee):
 * - Step input and output are served from the step_created/step_completed events; the step row
 *   carries state. Upstream wrote the same bytes twice (a load run: 1.6 GB of events plus 1.0 GB
 *   of steps). The one reader that needed the row's input (the runtime runs a queued step from the
 *   entity step_started reports) gets it from the lazy start in hand or from the step_created
 *   event; steps.get/steps.list read the payload back from the events unless resolveData is none.
 *   step_completed commits the terminal UPDATE and its event together, since the result may live
 *   in the event alone. The transition takes two releases, like the blobs below and on the same
 *   flag: while OSINARA_WORKFLOW_PAYLOAD_BLOBS is off the rows are still written as before (the
 *   readers already prefer the events, and a rollback to the previous release still finds every
 *   step's input and output on its row); once the flag is on, the row columns stay empty.
 * - A run's slot marker (`workflow_event_slots`) is read once per process, not once per event.
 * - Large strings of event payloads (the system prompt, instruction blocks, the history snapshot)
 *   are stored once by SHA-256 in `workflow_payload_blobs` (migration 0020); the event keeps a
 *   marker and every read restores the original bytes. Writes stay behind
 *   OSINARA_WORKFLOW_PAYLOAD_BLOBS=1 until every reader in the fleet restores them (two releases,
 *   as for every contract change); reads of both forms are always on.
 *
 * Every replacement is taken from the installed 5.0.0-beta.35 `dist/storage.js` (tsc output), not
 * from the vendored fork, and runs through the caller's count-checked `replaceExact`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";

type Replace = (path: string, before: string, after: string) => Promise<void>;

export const PAYLOAD_BLOBS_MIGRATION_TAG = "0020_add_payload_blobs";

export const PAYLOAD_BLOBS_MIGRATION_SQL = `-- Osinara fork (4 October 2026). Large strings of event payloads (the system prompt, instruction
-- blocks, the history snapshot of a session) are stored once by content hash; the event keeps a
-- marker. A reference row per run and hash lets the run's deletion free its blobs; \`touched_at\` is refreshed
-- by every write under the row's lock, which is what keeps the sweep from racing a writer.
CREATE TABLE "workflow"."workflow_payload_blobs" (
  "hash" varchar(64) PRIMARY KEY,
  "bytes" bytea NOT NULL,
  "size" integer NOT NULL,
  "touched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow"."workflow_payload_blob_refs" (
  "run_id" varchar NOT NULL,
  "hash" varchar(64) NOT NULL,
  CONSTRAINT "workflow_payload_blob_refs_pk" PRIMARY KEY ("run_id", "hash")
);
--> statement-breakpoint
CREATE INDEX "workflow_payload_blob_refs_hash_index" ON "workflow"."workflow_payload_blob_refs" ("hash");
`;

const OLD_JOURNAL_TAIL = `      "tag": "0019_add_event_slots",
      "breakpoints": true
    }
  ]
}`;

const NEW_JOURNAL_TAIL = `      "tag": "0019_add_event_slots",
      "breakpoints": true
    },
    {
      "idx": 20,
      "version": "7",
      "when": 1791158400000,
      "tag": "${PAYLOAD_BLOBS_MIGRATION_TAG}",
      "breakpoints": true
    }
  ]
}`;

export async function patchWorkflowJournalStorage(
  replace: Replace,
  world = resolve("node_modules/@workflow/world-postgres"),
  runtimeSource = resolve("scripts/eve-runtime/payload-blobs.ts"),
): Promise<void> {
  const pkg = JSON.parse(await readFile(`${world}/package.json`, "utf8")) as { version?: string };
  if (pkg.version !== "5.0.0-beta.35") {
    throw new Error("AGENT_WORKFLOW_PATCH_VERSION_UNSUPPORTED: Expected world-postgres 5.0.0-beta.35");
  }
  const storage = `${world}/dist/storage.js`;
  await patchStepPayloadsInEvents(replace, storage);
  await patchSlotMarkerCache(replace, storage);
  await writeFile(`${world}/dist/osinara-payload-blobs.js`, stripTypeScriptTypes(await readFile(runtimeSource, "utf8")));
  await patchPayloadBlobs(replace, storage);
  await replace(`${world}/dist/storage.d.ts`, `export declare function createStepsStorage(drizzle: Drizzle): Storage['steps'];`, `export declare function createStepsStorage(drizzle: Drizzle): Storage['steps'];
/** Test hook of the Osinara payload blob patch: forget every cached blob, as a fresh process would. */
export declare function resetPayloadBlobCacheForTest(): void;`);
  await writeFile(`${world}/src/drizzle/migrations/${PAYLOAD_BLOBS_MIGRATION_TAG}.sql`, PAYLOAD_BLOBS_MIGRATION_SQL);
  await replace(`${world}/src/drizzle/migrations/meta/_journal.json`, OLD_JOURNAL_TAIL, NEW_JOURNAL_TAIL);
}

// ---------------------------------------------------------------------------------------------
// Step input and output in the event log only.
// ---------------------------------------------------------------------------------------------

async function patchStepPayloadsInEvents(replace: Replace, storage: string): Promise<void> {
  // step_created: the row loses its input; the entity reported back still carries it.
  await replace(storage, `                    stepName: eventData.stepName,
                    input: eventData.input,
                    status: 'pending',
                    attempt: 0,
                    // Propagate specVersion from the event to the step entity
                    specVersion: effectiveSpecVersion,
                })
                    .onConflictDoNothing()
                    .returning();
                if (stepValue) {
                    step = deserializeStepError(compact(stepValue));
                }`, `                    stepName: eventData.stepName,
                    // Osinara fork: the input is served from the step_created event (see
                    // \`attachStepPayloads\`); the row column is written only until the flag
                    // is on, so a rollback to the previous release still finds it.
                    ...(stepPayloadColumnsEnabled() ? { input: eventData.input } : {}),
                    status: 'pending',
                    attempt: 0,
                    // Propagate specVersion from the event to the step entity
                    specVersion: effectiveSpecVersion,
                })
                    .onConflictDoNothing()
                    .returning();
                if (stepValue) {
                    step = deserializeStepError(compact({ ...stepValue, input: eventData.input }));
                }`);
  // Lazy step_started: the row loses its input; the synthetic step_created event below keeps it.
  await replace(storage, `                            stepName: lazyData.stepName,
                            input: lazyData.input,
                            status: 'pending',`, `                            stepName: lazyData.stepName,
                            // The input goes into the synthetic step_created event below; the
                            // row column is written only until the flag is on.
                            ...(stepPayloadColumnsEnabled() ? { input: lazyData.input } : {}),
                            status: 'pending',`);
  // step_started reports the entity the runtime runs the queued step from, input included.
  await replace(storage, `                        .returning();
                    if (stepValue) {
                        step = deserializeStepError(compact(stepValue));
                    }
                    else {
                        const [existing] = await tx`, `                        .returning();
                    if (stepValue) {
                        // The runtime runs a queued step from the entity reported here,
                        // so the input comes back with it: from the lazy start in hand,
                        // otherwise from the step_created event (the row no longer has it).
                        const input = stepValue.input ??
                            (lazyStepStart && !validatedStep
                                ? data.eventData.input
                                : await stepInputFromEvent(tx, effectiveRunId, data.correlationId));
                        step = deserializeStepError(compact({ ...stepValue, input }));
                    }
                    else {
                        const [existing] = await tx`);
  // step_completed: no output on the row, and the terminal UPDATE commits with its event.
  await replace(storage, `            if (data.eventType === 'step_completed') {
                const eventData = data.eventData;
                const [stepValue] = await drizzle
                    .update(Schema.steps)
                    .set({
                    status: 'completed',
                    output: eventData.result,
                    completedAt: now,
                })
                    .where(and(eq(Schema.steps.runId, effectiveRunId), eq(Schema.steps.stepId, data.correlationId), notInArray(Schema.steps.status, terminalStepStatuses)))
                    .returning();
                if (stepValue) {
                    step = deserializeStepError(compact(stepValue));
                }
                else {
                    // Step not updated - check if it exists and why
                    const [existing] = await getStepForValidation.execute({
                        runId: effectiveRunId,
                        stepId: data.correlationId,
                    });
                    if (!existing) {
                        throw new WorkflowWorldError(\`Step "\${data.correlationId}" not found\`);
                    }
                    if (isTerminalStepStatus(existing.status)) {
                        throw new EntityConflictError(\`Cannot modify step in terminal state "\${existing.status}"\`);
                    }
                }
            }`, `            if (data.eventType === 'step_completed') {
                const eventData = data.eventData;
                // Osinara fork: the result is served from the step_completed event, so
                // the terminal UPDATE and the event commit together. Upstream wrote
                // them separately; with the result no longer on the row, a failure
                // between the two would have left a completed step without its result.
                // The row column is written only until the flag is on.
                value = await drizzle.transaction(async (tx) => {
                    const [stepValue] = await tx
                        .update(Schema.steps)
                        .set({
                        status: 'completed',
                        ...(stepPayloadColumnsEnabled() ? { output: eventData.result } : {}),
                        completedAt: now,
                    })
                        .where(and(eq(Schema.steps.runId, effectiveRunId), eq(Schema.steps.stepId, data.correlationId), notInArray(Schema.steps.status, terminalStepStatuses)))
                        .returning();
                    if (!stepValue) {
                        // Step not updated - check if it exists and why. Read through the
                        // transaction's connection: the prepared statement runs on the pool,
                        // and a transaction waiting for a second connection from an exhausted
                        // pool would hang.
                        const [existing] = await tx
                            .select({ status: Schema.steps.status })
                            .from(Schema.steps)
                            .where(and(eq(Schema.steps.runId, effectiveRunId), eq(Schema.steps.stepId, data.correlationId)))
                            .limit(1);
                        if (!existing) {
                            throw new WorkflowWorldError(\`Step "\${data.correlationId}" not found\`);
                        }
                        if (isTerminalStepStatus(existing.status)) {
                            throw new EntityConflictError(\`Cannot modify step in terminal state "\${existing.status}"\`);
                        }
                        throw new EntityConflictError(\`Step "\${data.correlationId}" could not be completed\`);
                    }
                    // The entity reported back carries the result it was just given.
                    step = deserializeStepError(compact({ ...stepValue, output: eventData.result }));
                    const eventValue = await insertEventRow(tx, {
                        runId: effectiveRunId,
                        eventId: await getEventId(tx),
                        correlationId: data.correlationId,
                        eventType: data.eventType,
                        eventData: storedEventData,
                        specVersion: effectiveSpecVersion,
                    });
                    if (!eventValue) {
                        throw new EntityConflictError(\`step_completed for step "\${data.correlationId}" could not be created\`);
                    }
                    eventId = eventValue.eventId;
                    return { createdAt: eventValue.createdAt };
                }, SLOT_INSERT_TRANSACTION);
            }`);
  // steps.get / steps.list: the payload comes back from the events unless resolveData is none.
  await replace(storage, `export function createStepsStorage(drizzle) {`, `/**
 * Fills the input and output of step rows from their step_created and
 * step_completed events.
 *
 * Osinara fork (3 October 2026). Upstream wrote every step's input and
 * output twice: into the event and into the step row, so a load run's
 * database was 1.6 GB of events plus 1.0 GB of steps holding the same bytes.
 * Replay reads a result from its step_completed event and the runtime keeps
 * the input it dispatched, so the row now carries the step's state only and
 * the payload is read back here for the one API that returns whole steps.
 * A row written before the change still has its columns and is left alone.
 */
async function stepInputFromEvent(db, runId, stepId) {
    const { events } = Schema;
    const [created] = await db
        .select({ eventData: events.eventData })
        .from(events)
        .where(and(eq(events.runId, runId), eq(events.correlationId, stepId), eq(events.eventType, 'step_created')))
        .limit(1);
    const eventData = await restoreEventData(db, created?.eventData);
    return eventData?.input;
}
async function attachStepPayloads(db, runId, rows) {
    const missing = rows.filter((row) => row.input == null || row.output == null);
    if (missing.length === 0)
        return;
    const { events } = Schema;
    const payloads = await db
        .select({
        correlationId: events.correlationId,
        eventData: events.eventData,
        eventType: events.eventType,
    })
        .from(events)
        .where(and(eq(events.runId, runId), inArray(events.correlationId, missing.map((row) => row.stepId)), inArray(events.eventType, ['step_created', 'step_completed'])))
        .orderBy(asc(events.eventId));
    for (const row of missing) {
        for (const event of payloads) {
            if (event.correlationId !== row.stepId)
                continue;
            const eventData = await restoreEventData(db, event.eventData);
            if (event.eventType === 'step_created' && row.input == null) {
                row.input = eventData?.input;
            }
            else if (event.eventType === 'step_completed' && row.output == null) {
                row.output = eventData?.result;
            }
        }
    }
}
export function createStepsStorage(drizzle) {`);
  await replace(storage, `            value.error ||= parseErrorJson(value.errorJson);
            const deserialized = deserializeStepError(compact(value));
            const parsed = StepSchema.parse(deserialized);
            const resolveData = params?.resolveData ?? 'all';
            return filterStepData(parsed, resolveData);`, `            value.error ||= parseErrorJson(value.errorJson);
            const resolveData = params?.resolveData ?? 'all';
            if (resolveData !== 'none')
                await attachStepPayloads(drizzle, runId, [value]);
            const deserialized = deserializeStepError(compact(value));
            const parsed = StepSchema.parse(deserialized);
            return filterStepData(parsed, resolveData);`);
  await replace(storage, `            const resolveData = params?.resolveData ?? 'all';
            return {
                data: values.map((v) => {
                    v.output ||= v.outputJson;
                    v.input ||= v.inputJson;
                    v.error ||= parseErrorJson(v.errorJson);`, `            const resolveData = params?.resolveData ?? 'all';
            if (resolveData !== 'none')
                await attachStepPayloads(drizzle, params.runId, values);
            return {
                data: values.map((v) => {
                    v.output ||= v.outputJson;
                    v.input ||= v.inputJson;
                    v.error ||= parseErrorJson(v.errorJson);`);
}

// ---------------------------------------------------------------------------------------------
// The slot marker of a run is read once per process.
// ---------------------------------------------------------------------------------------------

async function patchSlotMarkerCache(replace: Replace, storage: string): Promise<void> {
  await replace(storage, `async function allocateEventId(db, runId) {
    const [row] = await db
        .select({ runId: Schema.eventSlots.runId })
        .from(Schema.eventSlots)
        .where(eq(Schema.eventSlots.runId, runId))
        .limit(1);
    return row ? nextSlotId(runId) : \`wevt_\${legacyEventUlid()}\`;
}`, `/**
 * Runs this process has seen marked as slot-numbered (Osinara fork, 4 October
 * 2026). The marker is never removed while a run lives, so once seen it holds;
 * only a run without one is re-read, because the marker could still be inserted
 * by a creation in flight. Before this every event cost one marker read, about
 * ten a turn and the fifth most time of all Workflow statements in a load run.
 * The set is bounded by a plain reset: a miss after it costs one read again.
 */
const SLOT_MARKED_RUNS_MAX = 50_000;
const slotMarkedRuns = new Set();
function rememberSlotMarker(runId) {
    if (slotMarkedRuns.size >= SLOT_MARKED_RUNS_MAX)
        slotMarkedRuns.clear();
    slotMarkedRuns.add(runId);
}
async function allocateEventId(db, runId) {
    if (slotMarkedRuns.has(runId))
        return nextSlotId(runId);
    const [row] = await db
        .select({ runId: Schema.eventSlots.runId })
        .from(Schema.eventSlots)
        .where(eq(Schema.eventSlots.runId, runId))
        .limit(1);
    if (!row)
        return \`wevt_\${legacyEventUlid()}\`;
    rememberSlotMarker(runId);
    return nextSlotId(runId);
}`);
  await replace(storage, `    await db.insert(Schema.eventSlots).values({ runId }).onConflictDoNothing();
    return slotToEventId(FIRST_EVENT_SLOT);`, `    await db.insert(Schema.eventSlots).values({ runId }).onConflictDoNothing();
    // Inside the creation transaction: should it roll back, the run row goes
    // with it and a later creation of the same id opens the marker again.
    rememberSlotMarker(runId);
    return slotToEventId(FIRST_EVENT_SLOT);`);
}

// ---------------------------------------------------------------------------------------------
// Large payload strings stored once, by content hash.
// ---------------------------------------------------------------------------------------------

const BLOB_FUNCTIONS = `/**
 * Large strings of event payloads live once in \`workflow_payload_blobs\`
 * (Osinara fork, 4 October 2026, see osinara-payload-blobs.js). An event
 * stores markers; every read below restores the original bytes before the
 * runtime sees them.
 */
const payloadBlobCache = createPayloadBlobCache();
/**
 * Writes run in the caller's transaction and nothing is remembered across it:
 * a rollback leaves no trace and the next attempt writes again. The blob row
 * is touched under its own row lock before the reference is added, so a sweep
 * deleting unreferenced blobs either waits for this commit and then sees the
 * fresh touch, or deleted the row first and the insert recreates it. The rows
 * are locked in hash order, so two writers sharing blobs cannot deadlock.
 */
async function storePayloadBlobs(db, runId, blobs) {
    for (const hash of [...blobs.keys()].sort()) {
        const bytes = blobs.get(hash);
        payloadBlobCache.set(hash, bytes);
        const touched = await db.execute(sql \`UPDATE workflow.workflow_payload_blobs SET touched_at = now() WHERE hash = \${hash}\`);
        if ((touched.rowCount ?? 0) === 0) {
            await db.execute(sql \`INSERT INTO workflow.workflow_payload_blobs (hash, bytes, size)
            VALUES (\${hash}, \${Buffer.from(zstdCompressSync(bytes))}, \${bytes.length})
            ON CONFLICT (hash) DO UPDATE SET touched_at = now()\`);
        }
        await db.execute(sql \`INSERT INTO workflow.workflow_payload_blob_refs (run_id, hash)
          VALUES (\${runId}, \${hash}) ON CONFLICT DO NOTHING\`);
    }
}
/**
 * Blob payload writes stay off until every reader in the fleet restores them:
 * this release reads both forms, the next one sets the flag (two releases, as
 * for every contract change). Read per call so a test can switch it.
 */
const payloadBlobWritesEnabled = () => process.env.OSINARA_WORKFLOW_PAYLOAD_BLOBS === '1';
/**
 * Step rows keep their input and output columns on the same two-release path:
 * until the flag is on they are written as before, so a rollback to the
 * previous release still finds them; the readers already prefer the events.
 */
const stepPayloadColumnsEnabled = () => !payloadBlobWritesEnabled();
/** Test hook: forget every cached blob, as a fresh process would. */
export function resetPayloadBlobCacheForTest() {
    payloadBlobCache.clear();
}
/** Event data with its serialized payload fields split into blobs where that pays. */
async function dedupeEventData(db, runId, eventData) {
    if (!eventData || typeof eventData !== 'object')
        return eventData;
    let out = eventData;
    const blobs = new Map();
    for (const [field, value] of Object.entries(eventData)) {
        if (!(value instanceof Uint8Array))
            continue;
        // Opaque bytes that happen to start like a stored envelope are escaped so
        // a read never mistakes them for one.
        const escaped = escapePayload(value);
        if (escaped !== value) {
            if (out === eventData)
                out = { ...eventData };
            out[field] = escaped;
            continue;
        }
        if (!payloadBlobWritesEnabled())
            continue;
        const split = splitPayload(value);
        if (!split)
            continue;
        if (out === eventData)
            out = { ...eventData };
        out[field] = split.stored;
        for (const [hash, bytes] of split.blobs)
            blobs.set(hash, bytes);
    }
    if (blobs.size > 0)
        await storePayloadBlobs(db, runId, blobs);
    return out;
}
/** The blobs a payload needs, for this call alone: the shared cache may evict them meanwhile. */
async function loadPayloadBlobs(db, hashes) {
    const found = new Map();
    const missing = [];
    for (const hash of hashes) {
        const cached = payloadBlobCache.get(hash);
        if (cached === undefined)
            missing.push(hash);
        else
            found.set(hash, cached);
    }
    if (missing.length > 0) {
        // A Postgres array literal: the hashes are hex, so no quoting is needed.
        const result = await db.execute(sql \`SELECT hash, bytes FROM workflow.workflow_payload_blobs WHERE hash = ANY(\${\`{\${missing.join(',')}}\`}::text[])\`);
        for (const row of result.rows ?? result) {
            const bytes = new Uint8Array(zstdDecompressSync(row.bytes));
            found.set(row.hash, bytes);
            payloadBlobCache.set(row.hash, bytes);
        }
    }
    return found;
}
/** Event data as the runtime expects it: blob markers replaced by the strings they stand for. */
async function restoreEventData(db, eventData) {
    if (!eventData || typeof eventData !== 'object')
        return eventData;
    let out = eventData;
    for (const [field, value] of Object.entries(eventData)) {
        if (!(value instanceof Uint8Array))
            continue;
        if (isEscapedPayload(value)) {
            if (out === eventData)
                out = { ...eventData };
            out[field] = unescapePayload(value);
            continue;
        }
        if (!isSplitPayload(value))
            continue;
        const blobs = await loadPayloadBlobs(db, payloadBlobHashes(value));
        if (out === eventData)
            out = { ...eventData };
        out[field] = joinPayload(value, (hash) => blobs.get(hash));
    }
    return out;
}
`;

async function patchPayloadBlobs(replace: Replace, storage: string): Promise<void> {
  await replace(storage, `import { compact } from './util.js';`, `import { compact } from './util.js';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { createPayloadBlobCache, escapePayload, isEscapedPayload, isSplitPayload, joinPayload, payloadBlobHashes, splitPayload, unescapePayload, } from './osinara-payload-blobs.js';`);
  // Every event insert goes through insertEventRow, so the split happens in one place.
  await replace(storage, `async function insertEventRow(db, values) {
    const runId = values.runId;`, `${BLOB_FUNCTIONS}async function insertEventRow(db, values) {
    values = { ...values, eventData: await dedupeEventData(db, values.runId, values.eventData) };
    const runId = values.runId;`);
  // Every read of the world restores the original bytes before the runtime sees them.
  await replace(storage, `    const events = rows.map((row) => {
        row.eventData ||= row.eventDataJson;
        return stripEventDataRefs(EventSchema.parse(compact(row)), resolveData);
    });`, `    const events = [];
    for (const row of rows) {
        row.eventData ||= row.eventDataJson;
        row.eventData = await restoreEventData(db, row.eventData);
        events.push(stripEventDataRefs(EventSchema.parse(compact(row)), resolveData));
    }`);
  await replace(storage, `                const data = eventRows.map((e) => {
                    e.eventData ||= e.eventDataJson;
                    const parsed = EventSchema.parse(compact(e));
                    return stripEventDataRefs(parsed, resolveData);
                });`, `                const data = [];
                for (const e of eventRows) {
                    e.eventData ||= e.eventDataJson;
                    e.eventData = await restoreEventData(drizzle, e.eventData);
                    const parsed = EventSchema.parse(compact(e));
                    data.push(stripEventDataRefs(parsed, resolveData));
                }`);
  await replace(storage, `                const data = page.map((e) => {
                    e.eventData ||= e.eventDataJson;
                    return stripEventDataRefs(EventSchema.parse(compact(e)), resolveData);
                });`, `                const data = [];
                for (const e of page) {
                    e.eventData ||= e.eventDataJson;
                    e.eventData = await restoreEventData(drizzle, e.eventData);
                    data.push(stripEventDataRefs(EventSchema.parse(compact(e)), resolveData));
                }`);
  await replace(storage, `            value.eventData ||= value.eventDataJson;
            const parsed = EventSchema.parse(compact(value));`, `            value.eventData ||= value.eventDataJson;
            value.eventData = await restoreEventData(drizzle, value.eventData);
            const parsed = EventSchema.parse(compact(value));`);
  await replace(storage, `                    row.eventData ||= row.eventDataJson;
                    const event = EventSchema.parse(compact(row));`, `                    row.eventData ||= row.eventDataJson;
                    row.eventData = await restoreEventData(drizzle, row.eventData);
                    const event = EventSchema.parse(compact(row));`);
  await replace(storage, `            return {
                data: values.map((v) => {
                    v.eventData ||= v.eventDataJson;
                    const parsed = EventSchema.parse(compact(v));
                    return stripEventDataRefs(parsed, resolveData);
                }),
                cursor: values.at(-1)?.eventId ?? null,`, `            const data = [];
            for (const v of values) {
                v.eventData ||= v.eventDataJson;
                v.eventData = await restoreEventData(drizzle, v.eventData);
                const parsed = EventSchema.parse(compact(v));
                data.push(stripEventDataRefs(parsed, resolveData));
            }
            return {
                data,
                cursor: values.at(-1)?.eventId ?? null,`);
}
