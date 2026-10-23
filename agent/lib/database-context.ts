/**
 * Row-level security context of the application pool.
 *
 * Exports:
 * - `withFamilyDatabaseContext`: runs work whose every query sees only one family's rows.
 * - `withGroupDatabaseContext`: runs work of a group without a family (migration 175): only that
 *   group's rows, none of any family.
 * - `withSystemDatabaseContext`: runs installation-wide work (operator checks, digests) even when
 *   called from inside a family scope.
 * - `currentDatabaseContext`: the context the next checkout will carry.
 * - `scopeDatabaseContext`: wraps a pool so every checkout carries the current context.
 *
 * Key constructs:
 * - Migration 171 puts a policy on each of the 79 tables with `family_id`: a row is visible when
 *   `app.rls_system` is on or its family equals `app.family_id`. The superuser (migrations, tests)
 *   bypasses it; the runtime role `osinara_app` (since release H) does not.
 * - The context lives in AsyncLocalStorage and is written to the connection with session-level
 *   `set_config` at checkout, skipped when the connection already carries it. Outside a family
 *   scope a connection is in system mode, as before: background work keeps working unchanged.
 * - The model's path (tool execution, the turn's context) runs inside a family scope taken from the
 *   verified session auth, so a query that forgets `WHERE family_id` there returns nothing of
 *   another family instead of leaking it.
 * - Migration 175 adds a second permissive policy on the tables whose `family_id` may be NULL: a row
 *   without a family is visible when its group equals `app.group_id`. A family scope leaves
 *   `app.group_id` empty and a group scope leaves `app.family_id` empty, so neither reaches the other.
 * - `DATABASE_RLS_FAMILY_SCOPE=off` keeps every connection in system mode: the switch back if a
 *   tool turns out to need a cross-family read.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { Pool, PoolClient } from "pg";

export type DatabaseContext =
  | { readonly kind: "family"; readonly familyId: string }
  | { readonly kind: "group"; readonly groupId: string }
  | { readonly kind: "system" };

const SYSTEM: DatabaseContext = { kind: "system" };
const storage = new AsyncLocalStorage<DatabaseContext>();
const APPLIED = Symbol.for("osinara.databaseContext");
const SCOPED = Symbol.for("osinara.databaseContextScoped");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A family id the database can hold; `family_id` columns are uuid. */
export function isDatabaseFamilyId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function withFamilyDatabaseContext<T>(familyId: string, work: () => Promise<T>): Promise<T> {
  if (!isDatabaseFamilyId(familyId)) {
    throw new Error("AGENT_DATABASE_CONTEXT_INVALID: Семья для контекста базы указана неверно");
  }
  return storage.run({ familyId, kind: "family" }, work);
}

export function withGroupDatabaseContext<T>(groupId: string, work: () => Promise<T>): Promise<T> {
  if (!isDatabaseFamilyId(groupId)) {
    throw new Error("AGENT_DATABASE_CONTEXT_INVALID: Группа для контекста базы указана неверно");
  }
  return storage.run({ groupId, kind: "group" }, work);
}

export function withSystemDatabaseContext<T>(work: () => Promise<T>): Promise<T> {
  return storage.run(SYSTEM, work);
}

export function currentDatabaseContext(): DatabaseContext {
  if (process.env.DATABASE_RLS_FAMILY_SCOPE === "off") return SYSTEM;
  return storage.getStore() ?? SYSTEM;
}

function contextKey(context: DatabaseContext): string {
  if (context.kind === "family") return `family:${context.familyId}`;
  return context.kind === "group" ? `group:${context.groupId}` : "system";
}

async function applyContext(client: PoolClient): Promise<void> {
  const context = currentDatabaseContext();
  const key = contextKey(context);
  const carrier = client as PoolClient & { [APPLIED]?: string };
  if (carrier[APPLIED] === key) return;
  await client.query(
    `SELECT set_config('app.family_id', $1, false), set_config('app.group_id', $2, false),
            set_config('app.rls_system', $3, false)`,
    [
      context.kind === "family" ? context.familyId : "",
      context.kind === "group" ? context.groupId : "",
      context.kind === "system" ? "on" : "off",
    ],
  );
  carrier[APPLIED] = key;
}

/** Every `query` and `connect` of the pool carries the caller's context; wrapping twice is a no-op. */
export function scopeDatabaseContext<T extends Pool>(pool: T): T {
  const scoped = pool as T & { [SCOPED]?: true };
  if (scoped[SCOPED] === true) return pool;
  scoped[SCOPED] = true;
  const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
  pool.connect = (async (...args: unknown[]) => {
    if (args.length > 0) throw new Error("AGENT_DATABASE_CALLBACK_UNSUPPORTED: connect поддерживается только через promise");
    const client = await connect();
    try {
      await applyContext(client);
    } catch (error) {
      client.release(error instanceof Error ? error : true);
      throw error;
    }
    return client;
  }) as T["connect"];
  pool.query = (async (...args: unknown[]) => {
    if (typeof args.at(-1) === "function") {
      throw new Error("AGENT_DATABASE_CALLBACK_UNSUPPORTED: query поддерживается только через promise");
    }
    const client = await pool.connect();
    try {
      return await (client.query as (...queryArgs: unknown[]) => Promise<unknown>)(...args);
    } finally {
      client.release();
    }
  }) as T["query"];
  return pool;
}
