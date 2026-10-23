/**
 * Вторая семья в той же установке по коду `--new-family` на реальной PostgreSQL.
 *
 * Constructs covered:
 * - первый владелец по обычному коду, вторая семья по коду новой семьи, семьи не смешиваются;
 * - обычный код не создаёт вторую семью, код новой семьи не создаёт первого владельца и не работает дважды;
 * - человек, уже состоящий в семье, второй семьи не получает.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createBootstrapCode } from "./bootstrap-code.js";
import { closeDatabase, database } from "./database.js";
import { telegramRepository as repository } from "./telegram-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");
const suite = enabled ? describe : describe.skip;

async function issueCode(newFamily: boolean): Promise<string> {
  const generated = createBootstrapCode(new Date());
  await database().query("UPDATE bootstrap_codes SET consumed_at = now() WHERE consumed_at IS NULL");
  await database().query(
    "INSERT INTO bootstrap_codes (code_hash, created_at, expires_at, new_family) VALUES ($1, $2, $3, $4)",
    [generated.record.codeHash, generated.record.createdAt, generated.record.expiresAt, newFamily],
  );
  return generated.code;
}
const profile = (id: string) => ({ displayName: `Человек ${id}`, telegramUserId: id });
const families = async () => Number((await database().query("SELECT count(*) AS n FROM families")).rows[0].n);

suite("a second family by a new-family code", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families, users, bootstrap_codes CASCADE");
  });
  afterAll(closeDatabase);

  it("creates a second family with its own owner and leaves the first untouched", async () => {
    expect(await repository.claimFirstOwner(await issueCode(false), profile("1001"))).toBe("claimed");
    expect(await repository.claimNewFamily(await issueCode(true), profile("2002"))).toBe("claimed");

    expect(await families()).toBe(2);
    const first = await repository.findIdentity("1001");
    const second = await repository.findIdentity("2002");
    expect(first?.role).toBe("owner");
    expect(second?.role).toBe("owner");
    expect(first?.familyId).not.toBe(second?.familyId);
  });

  it("does not let an ordinary code create a second family, nor a new-family code the first owner", async () => {
    await repository.claimFirstOwner(await issueCode(false), profile("1001"));

    expect(await repository.claimNewFamily(await issueCode(false), profile("2002"))).toBe("invalid");
    expect(await repository.claimFirstOwner(await issueCode(true), profile("3003"))).toBe("configured");
    expect(await families()).toBe(1);
  });

  it("works once, rejects a wrong code, and never gives a member a second family", async () => {
    await repository.claimFirstOwner(await issueCode(false), profile("1001"));
    const code = await issueCode(true);

    expect(await repository.claimNewFamily("x".repeat(43), profile("2002"))).toBe("invalid");
    expect(await repository.claimNewFamily(code, profile("1001"))).toBe("configured");
    expect(await repository.claimNewFamily(code, profile("2002"))).toBe("claimed");
    expect(await repository.claimNewFamily(code, profile("4004"))).toBe("invalid");
    expect(await families()).toBe(2);
  });
});
