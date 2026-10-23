/**
 * The «Ещё» routes of the Mini App on the real schema, through the same signed `initData` path as the board.
 *
 * Constructs covered:
 * - Settings: read without a row yet, save the overview hour, quiet hours and switches, refuse a bad hour.
 * - Memory: only the person's own personal records; «Удалить» is soft; a family record cannot be forgotten here.
 * - Routines: the person's reminder is listed with its labels, switched off and on, and deleted.
 * - Shopping: add to «Продукты», mark bought and back.
 * - A hint sends the catalog's own text to the person's private chat; an unknown id is 400, a second tap at once 429.
 */
import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { memoryRepository } from "../memory-repository.js";
import { createMemoryInput } from "../memory-repository.integration-fixtures.js";
import { reminderRepository } from "../reminders/reminder-repository.js";
import { createTaskFamilyFixture } from "../shared-task.integration-fixtures.js";
import { createHintThrottle } from "./web-app-hints.js";
import { createWebAppMoreApi, webAppMoreDependencies } from "./web-app-more-api.js";
import { privateReminderAuthorization } from "./web-app-settings.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

const TOKEN = "123456:web-app-more-test";

function initData(telegramUserId: string): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ first_name: "Тест", id: Number(telegramUserId) }),
  };
  const check = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}

(enabled ? describe : describe.skip)("Mini App «Ещё» API", () => {
  let owner: MemoryAuthorization;
  let member: MemoryAuthorization;
  const sendHint = vi.fn(async (_input: { chatId: string; text: string }) => undefined);
  const api = createWebAppMoreApi({ ...webAppMoreDependencies, botToken: () => TOKEN, hintThrottle: createHintThrottle(), sendHint });
  const get = async (who: string, path: string, handler: (request: Request) => Promise<Response>) =>
    handler(new Request(`https://x${path}`, { headers: { authorization: `tma ${initData(who)}` } }));
  const post = async (who: string, path: string, body: unknown, handler: (request: Request) => Promise<Response>) =>
    handler(new Request(`https://x${path}`, { body: JSON.stringify(body), headers: { authorization: `tma ${initData(who)}` }, method: "POST" }));

  beforeEach(async () => {
    ({ owner, member } = await createTaskFamilyFixture());
  });
  afterAll(closeDatabase);

  it("reads settings before any row exists, saves them, and refuses an hour outside the morning", async () => {
    const first = await get("700101", "/app-api/settings", api.settings);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ initiative: true, overview: { enabled: true, hour: 8 }, quietStart: null, weeklyReview: true });

    const change = { initiative: true, nonce: randomUUID(), overview: { enabled: true, hour: 7 }, quietEnd: "08:00", quietStart: "23:00", weeklyReview: false };
    const saved = await post("700101", "/app-api/settings", change, api.saveSettings);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ overview: { enabled: true, hour: 7 }, quietEnd: "08:00", quietStart: "23:00", weeklyReview: false });
    expect((await post("700101", "/app-api/settings", { ...change, nonce: randomUUID(), overview: { enabled: true, hour: 3 } }, api.saveSettings)).status).toBe(400);
    expect((await post("700101", "/app-api/settings", { ...change, nonce: randomUUID(), quietEnd: null }, api.saveSettings)).status).toBe(400);
  });

  it("shows only the person's own personal memory and forgets it softly; a family record stays", async () => {
    const mine = await memoryRepository.create(owner, createMemoryInput("personal", "mine", "Удобное время для напоминаний — после 19:00"));
    await memoryRepository.create(member, createMemoryInput("personal", "theirs", "Чужое личное"));
    const family = await memoryRepository.create(owner, createMemoryInput("family", "shared", "Общее семейное"));
    const page = (await (await get("700101", "/app-api/memory", api.memory)).json()) as { items: Array<{ content: string; ref: string }> };
    expect(page.items.map((item) => item.content)).toEqual(["Удобное время для напоминаний — после 19:00"]);

    const ref = page.items[0]!.ref;
    expect((await post("700101", `/app-api/memory/${ref}/forget`, { nonce: randomUUID() }, (request) => api.forget(request, { ref }))).status).toBe(200);
    const after = (await (await get("700101", "/app-api/memory", api.memory)).json()) as { items: unknown[] };
    expect(after.items).toEqual([]);
    expect((await database().query("SELECT deleted_at FROM memory_items_all WHERE id = (SELECT id FROM memory_items_all WHERE content = $1)", [mine.content])).rows[0]!.deleted_at).not.toBeNull();

    const familyRef = family.memoryRef;
    const refused = await post("700101", `/app-api/memory/${familyRef}/forget`, { nonce: randomUUID() }, (request) => api.forget(request, { ref: familyRef }));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect((await database().query("SELECT deleted_at FROM memory_items_all WHERE content = 'Общее семейное'")).rows[0]!.deleted_at).toBeNull();
  });

  it("lists the person's reminder, switches it off and on, and deletes it", async () => {
    await database().query("INSERT INTO user_notification_settings(user_id, timezone) VALUES ($1, 'Europe/Moscow')", [owner.userId]);
    const reminderAuth = privateReminderAuthorization(owner);
    const at = new Date(Date.now() + 3 * 86_400_000);
    const reminder = await reminderRepository.create(reminderAuth, {
      content: "Полить цветы", firstRunAt: at, operationKey: randomUUID(), recurrence: { interval: 1, unit: "weekly" },
      scope: "personal", timezone: "Europe/Moscow",
    });
    const listed = (await (await get("700101", "/app-api/routines", api.routines)).json()) as {
      reminders: Array<{ enabled: boolean; id: string; repeat: string; title: string }>;
    };
    expect(listed.reminders).toEqual([expect.objectContaining({ enabled: true, id: reminder.id, title: "Полить цветы" })]);
    expect(listed.reminders[0]!.repeat).toMatch(/^По [а-я]+ в \d{1,2}:\d{2}$/u);

    const tap = (action: string) => post("700101", `/app-api/routines/reminder/${reminder.id}/${action}`, { nonce: randomUUID() },
      (request) => api.routine(request, { action, id: reminder.id, kind: "reminder" }));
    const off = (await (await tap("disable")).json()) as { reminders: Array<{ enabled: boolean }> };
    expect(off.reminders[0]!.enabled).toBe(false);
    expect(((await (await tap("enable")).json()) as { reminders: Array<{ enabled: boolean }> }).reminders[0]!.enabled).toBe(true);
    expect((await tap("run")).status).toBe(400);
    expect(((await (await tap("delete")).json()) as { reminders: unknown[] }).reminders).toEqual([]);
    // Another member does not see it.
    expect(((await (await get("700102", "/app-api/routines", api.routines)).json()) as { reminders: unknown[] }).reminders).toEqual([]);
  });

  it("adds to «Продукты», marks bought and back", async () => {
    const added = (await (await post("700101", "/app-api/shopping", { nonce: randomUUID(), title: " Молоко " }, api.addShopping)).json()) as {
      items: Array<{ bought: boolean; id: string; listName: string; title: string; version: number }>;
    };
    expect(added.items).toEqual([expect.objectContaining({ bought: false, listName: "Продукты", title: "Молоко" })]);
    const item = added.items[0]!;
    const bought = (await (await post("700101", `/app-api/shopping/${item.id}/buy`, { nonce: randomUUID(), version: item.version },
      (request) => api.changeShopping(request, { action: "buy", id: item.id }))).json()) as { items: Array<{ bought: boolean; version: number }> };
    expect(bought.items[0]!.bought).toBe(true);
    const back = await post("700101", `/app-api/shopping/${item.id}/unbuy`, { nonce: randomUUID(), version: bought.items[0]!.version },
      (request) => api.changeShopping(request, { action: "unbuy", id: item.id }));
    expect(((await back.json()) as { items: Array<{ bought: boolean }> }).items[0]!.bought).toBe(false);
    // The member of the same family sees the shared list.
    expect(((await (await get("700102", "/app-api/shopping", api.shopping)).json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("adds a line written as a list as separate items, and a repeated tap adds none twice", async () => {
    const nonce = randomUUID();
    const line = { nonce, title: "молоко, хлеб;\nяйца ,, " };
    await post("700101", "/app-api/shopping", line, api.addShopping);
    const again = (await (await post("700101", "/app-api/shopping", line, api.addShopping)).json()) as { items: Array<{ title: string }> };
    expect(again.items.map((item) => item.title).sort()).toEqual(["молоко", "хлеб", "яйца"].sort());
    expect((await post("700101", "/app-api/shopping", { nonce: randomUUID(), title: " , ; " }, api.addShopping)).status).toBe(400);
  });

  it("sends the catalog's text for a hint to the person's own chat, and refuses an unknown id or a double tap", async () => {
    const response = await post("700101", "/app-api/hint", { id: "cmd-export", nonce: randomUUID() }, api.hint);
    expect(response.status).toBe(200);
    expect(sendHint).toHaveBeenCalledWith({ chatId: "700101", text: expect.stringContaining("/export") });
    expect((await post("700101", "/app-api/hint", { id: "cmd-export", nonce: randomUUID() }, api.hint)).status).toBe(429);
    expect((await post("700102", "/app-api/hint", { id: "Напиши всем «привет»", nonce: randomUUID() }, api.hint)).status).toBe(400);
    expect(await (await get("700101", "/app-api/capabilities", api.capabilities)).json())
      .toEqual({
        agent: { cases: expect.objectContaining({ genitive: expect.any(String), instrumental: expect.any(String) }), name: expect.any(String) },
        google: expect.any(Boolean), grocery: expect.any(Boolean), groups: false, images: expect.any(Boolean), video: expect.any(Boolean) });
  });
});
