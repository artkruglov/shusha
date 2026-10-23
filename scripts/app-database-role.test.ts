/**
 * Least-privilege application role tests.
 *
 * Constructs covered:
 * - `requireAppDatabaseConfig`: the app connection must be the fixed role, on the same server
 *   and database as the migration connection, with a password, and not the owner itself.
 */
import { describe, expect, it } from "vitest";

import { requireAppDatabaseConfig } from "./app-database-role.ts";

const ADMIN_URL = "postgresql://osinara:owner-secret@postgres:5432/osinara";

describe("requireAppDatabaseConfig", () => {
  it("accepts the app role on the migration connection's database and decodes the password", () => {
    expect(requireAppDatabaseConfig(ADMIN_URL, "postgresql://osinara_app:a%27b@postgres:5432/osinara")).toEqual({
      database: "osinara",
      password: "a'b",
    });
  });

  it.each([
    ["another role", "postgresql://osinara:x@postgres:5432/osinara"],
    ["another database", "postgresql://osinara_app:x@postgres:5432/osinara_workflow"],
    ["another server", "postgresql://osinara_app:x@elsewhere:5432/osinara"],
    ["another port", "postgresql://osinara_app:x@postgres:5433/osinara"],
    ["no password", "postgresql://osinara_app@postgres:5432/osinara"],
    ["not a PostgreSQL URL", "http://osinara_app:x@postgres:5432/osinara"],
    ["not a URL", "osinara_app"],
  ])("refuses %s", (_label, appUrl) => {
    expect(() => requireAppDatabaseConfig(ADMIN_URL, appUrl)).toThrowError(/AGENT_APP_DATABASE_/u);
  });

  it("refuses when the migration connection is the app role itself", () => {
    expect(() => requireAppDatabaseConfig(
      "postgresql://osinara_app:x@postgres:5432/osinara",
      "postgresql://osinara_app:x@postgres:5432/osinara",
    )).toThrowError(/AGENT_APP_DATABASE_BOUNDARY_INVALID/u);
  });
});
