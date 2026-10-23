/**
 * The Mini App's one-by-one review of tasks that have not moved, on the real schema, through signed `initData`.
 *
 * Covered: a task unchanged for two weeks is listed, a fresh one is not; «Оставить» takes it off the list until it
 * changes; «Через неделю» moves the date a week from today and so the task is no longer stale.
 */
import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const currentMember = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../telegram-current-membership.js", () => ({ isCurrentTelegramMember: currentMember }));

import { closeDatabase, database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { createTaskFamilyFixture, makeTask } from "../shared-task.integration-fixtures.js";
import { createWebAppStaleApi, webAppStaleDependencies, type WebAppStaleTask } from "./web-app-stale-api.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

const TOKEN = "123456:web-app-stale-test";

function initData(telegramUserId: string): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ first_name: "Тест", id: Number(telegramUserId) }),
  };
  const check = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}

(enabled ? describe : describe.skip)("Mini App review of tasks without movement", () => {
  let owner: MemoryAuthorization;
  const api = createWebAppStaleApi({
    ...webAppStaleDependencies, botToken: () => TOKEN, stale: { ...webAppStaleDependencies.stale, timezone: async () => "UTC" },
  });
  const headers = { authorization: () => `tma ${initData("700101")}` };
  const list = async () => ((await (await api.list(new Request("https://x/app-api/stale", {
    headers: { authorization: headers.authorization() } }))).json()) as { tasks: WebAppStaleTask[] }).tasks;
  const answer = async (id: string, action: string, version: number) => (await api.answer(new Request("https://x/app-api/stale", {
    body: JSON.stringify({ nonce: randomUUID(), version }), headers: { authorization: headers.authorization() }, method: "POST",
  }), { action, id })).json() as Promise<{ line: string; tasks: WebAppStaleTask[] }>;

  beforeEach(async () => {
    currentMember.mockResolvedValue(true);
    ({ owner } = await createTaskFamilyFixture());
  });
  afterAll(closeDatabase);

  it("lists what has not moved for two weeks, and answers it the same way the chat button does", async () => {
    const old = await makeTask(owner, "Договориться о встрече");
    const kept = await makeTask(owner, "Разобрать шкаф");
    await makeTask(owner, "Свежее дело");
    await database().query("UPDATE shared_tasks SET updated_at = now() - interval '30 days' WHERE id = ANY($1::uuid[])", [[old.id, kept.id]]);

    expect((await list()).map((task) => task.title)).toEqual(expect.arrayContaining(["Договориться о встрече", "Разобрать шкаф"]));
    expect((await list()).map((task) => task.title)).not.toContain("Свежее дело");

    const afterKeep = await answer(kept.id, "keep", kept.version);
    expect(afterKeep.line).toContain("Оставлено как есть: Разобрать шкаф");
    expect(afterKeep.tasks.map((task) => task.title)).toEqual(["Договориться о встрече"]);

    const afterWeek = await answer(old.id, "week", old.version);
    expect(afterWeek.line).toMatch(/^Перенесено на .+: Договориться о встрече$/u);
    expect(afterWeek.tasks).toEqual([]);
    const due = (await database().query<{ due_on: string }>("SELECT due_on::text FROM shared_tasks WHERE id=$1", [old.id])).rows[0]!;
    expect(due.due_on).toBe(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
  });

  it("answers only a card of this review: a task that is not without movement is a conflict", async () => {
    const fresh = await makeTask(owner, "Свежее дело");
    const response = await api.answer(new Request("https://x/app-api/stale", {
      body: JSON.stringify({ nonce: randomUUID(), version: fresh.version }), headers: { authorization: headers.authorization() }, method: "POST",
    }), { action: "week", id: fresh.id });
    expect(response.status).toBe(409);
    const due = (await database().query<{ due_on: string | null }>("SELECT due_on::text FROM shared_tasks WHERE id=$1", [fresh.id])).rows[0]!;
    expect(due.due_on).toBeNull();
  });

  it("refuses an unknown action", async () => {
    const task = await makeTask(owner, "Дело");
    const response = await api.answer(new Request("https://x/app-api/stale", {
      body: JSON.stringify({ nonce: randomUUID(), version: task.version }), headers: { authorization: headers.authorization() }, method: "POST",
    }), { action: "delete", id: task.id });
    expect(response.status).toBe(400);
  });
});
