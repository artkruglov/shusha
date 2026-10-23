/**
 * Least-privilege PostgreSQL role of the running application.
 *
 * Exports:
 * - `APP_DATABASE_ROLE`: the fixed role name.
 * - `requireAppDatabaseConfig`: validates APP_DATABASE_URL against the migration connection.
 * - `provisionAppDatabaseRole`: creates or updates the role and grants it rows of every table.
 *
 * Key constructs:
 * - Migrations keep the owner connection; the agent and its workers connect as this role, which
 *   reads and changes rows but cannot create, alter, drop or truncate tables.
 * - The grants are applied after every migration run, so a table a migration adds is covered in
 *   the same release; the migration ledger stays out of reach.
 */
import { escapeIdentifier, escapeLiteral } from "pg";

export const APP_DATABASE_ROLE = "osinara_app";

interface AppDatabaseConfig {
  database: string;
  password: string;
}

interface QueryClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch (error) {
    throw new Error(
      "AGENT_APP_DATABASE_URL_INVALID: Строка подключения приложения к PostgreSQL некорректна",
      { cause: error },
    );
  }
}

export function requireAppDatabaseConfig(adminUrl: string, appUrl: string): AppDatabaseConfig {
  const admin = parseUrl(adminUrl);
  const app = parseUrl(appUrl);
  // The fixed role keeps every DDL identifier static; the same server and database keep the
  // grants on the tables the migrations just created.
  if (
    !["postgres:", "postgresql:"].includes(app.protocol) ||
    app.username !== APP_DATABASE_ROLE ||
    admin.username === APP_DATABASE_ROLE ||
    app.hostname !== admin.hostname ||
    app.port !== admin.port ||
    app.pathname !== admin.pathname ||
    app.pathname.length < 2 ||
    !app.password
  ) {
    throw new Error(
      `AGENT_APP_DATABASE_BOUNDARY_INVALID: Приложение должно подключаться ролью ${APP_DATABASE_ROLE} к той же базе, что и миграции`,
    );
  }
  return {
    database: decodeURIComponent(app.pathname.slice(1)),
    password: decodeURIComponent(app.password),
  };
}

export async function provisionAppDatabaseRole(client: QueryClient, config: AppDatabaseConfig): Promise<void> {
  const role = escapeIdentifier(APP_DATABASE_ROLE);
  const flags = `LOGIN PASSWORD ${escapeLiteral(config.password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`;
  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [APP_DATABASE_ROLE]);
  await client.query(existing.rows.length > 0 ? `ALTER ROLE ${role} ${flags}` : `CREATE ROLE ${role} ${flags}`);

  for (const statement of [
    `GRANT CONNECT ON DATABASE ${escapeIdentifier(config.database)} TO ${role}`,
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`,
    // A row here would make the next release skip a migration.
    `REVOKE ALL ON schema_migrations FROM ${role}`,
  ]) {
    await client.query(statement);
  }
}
