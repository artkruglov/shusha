/**
 * The «Семья» tab of the Mini App on the real schema, through the signed `initData` path.
 *
 * Constructs covered:
 * - The summary shows the family's care areas with who keeps them, own and others' personal time (others only as busy
 *   hours, never the title), traditions with the last mark, decisions with the person's own answer, ideas.
 * - «Беру» takes an area; «Было сегодня» marks a tradition once a day; «Согласен» answers a decision; a window is added
 *   and removed; every change answers with the whole tab again.
 * - «Сегодня» of a tradition is the viewer's own mark; who else marked it today is named by first name.
 */
import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const currentMember = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../telegram-current-membership.js", () => ({ isCurrentTelegramMember: currentMember }));

import { careAreaRepository } from "../care-areas/care-area-repository.js";
import { closeDatabase, database } from "../database.js";
import { jointDecisionRepository } from "../joint-decisions/joint-decision-repository.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { personalTimeRepository } from "../personal-time/personal-time-repository.js";
import { sharedTaskRepository as tasks } from "../shared-task-repository.js";
import { createTaskFamilyFixture } from "../shared-task.integration-fixtures.js";
import { createWebAppFamilyApi, webAppFamilyDependencies } from "./web-app-family-api.js";
import type { WebAppFamily } from "./web-app-family.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

const TOKEN = "123456:web-app-family-test";

function initData(telegramUserId: string): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ first_name: "Тест", id: Number(telegramUserId) }),
  };
  const check = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}

(enabled ? describe : describe.skip)("Mini App «Семья» API", () => {
  let owner: MemoryAuthorization;
  let member: MemoryAuthorization;
  let familyGroup: MemoryAuthorization;
  const api = createWebAppFamilyApi({ ...webAppFamilyDependencies, botToken: () => TOKEN });
  const headers = (who: string) => ({ authorization: `tma ${initData(who)}` });
  const read = async (who: string) => (await (await api.read(new Request("https://x/app-api/family", { headers: headers(who) }))).json()) as WebAppFamily;
  const post = async (who: string, body: unknown, handler: (request: Request, params?: Record<string, string>) => Promise<Response>, params: Record<string, string> = {}) =>
    handler(new Request("https://x/app-api/family", { body: JSON.stringify(body), headers: headers(who), method: "POST" }), params);

  beforeEach(async () => {
    currentMember.mockResolvedValue(true);
    ({ owner, member, familyGroup } = await createTaskFamilyFixture());
  });
  afterAll(closeDatabase);

  it("shows the family's approach and keeps others' personal time to busy hours", async () => {
    await careAreaRepository.execute(owner, { action: "create", title: "Машина" });
    await personalTimeRepository.add(member, { endsAt: "21:00", startsAt: "20:00", title: "Йога", weekday: 3 });
    await personalTimeRepository.add(owner, { endsAt: "21:00", startsAt: "19:00", title: "Бег", weekday: 3 });
    await tasks.execute(owner, { action: "create", kind: "ritual", title: "Настолки по средам" } as never, randomUUID(), { visibility: "family" });
    await tasks.execute(owner, { action: "create", kind: "idea", title: "Попробовать керамику" } as never, randomUUID());
    const people = (await jointDecisionRepository.execute(familyGroup, { action: "participants" }, "people")).participants!;
    await jointDecisionRepository.execute(familyGroup, {
      action: "create", partnerRef: people.find((person) => person.name === "Member")!.participantRef, title: "В воскресенье в парк",
    }, "decision");

    const view = await read("700101");
    expect(view.areas.map((area) => [area.title, area.owner])).toEqual([["Машина", null]]);
    expect(view.time.mine.map((slot) => slot.title)).toEqual(["Бег"]);
    expect(view.time.others).toEqual([{ endsAt: "21:00", name: "Member", startsAt: "20:00", weekday: 3 }]);
    expect(JSON.stringify(view.time.others)).not.toContain("Йога");
    expect(view.traditions.map((tradition) => [tradition.title, tradition.last])).toEqual([["Настолки по средам", null]]);
    expect(view.ideas.map((idea) => [idea.title, idea.mine])).toEqual([["Попробовать керамику", true]]);
    expect(view.decisions.map((decision) => [decision.title, decision.isProposer, decision.answered])).toEqual([["В воскресенье в парк", true, false]]);
    expect(view.participants[0]).toMatchObject({ me: true, name: "Owner" });
  });

  it("takes an area, marks a tradition, answers a decision and adds and removes a window", async () => {
    const area = (await careAreaRepository.execute(owner, { action: "create", title: "Садик" }) as unknown as { area: { id: string; version: number } }).area;
    let view = (await (await post("700102", { nonce: randomUUID(), version: area.version }, api.area, { action: "claim", id: area.id })).json()) as WebAppFamily;
    expect(view.areas[0]).toMatchObject({ mine: true, owner: "Member" });

    const ritual = (await tasks.execute(member, { action: "create", kind: "ritual", title: "Блины в воскресенье" } as never, randomUUID(), { visibility: "family" })).task!;
    view = (await (await post("700102", { nonce: randomUUID() }, api.tradition, { id: ritual.id })).json()) as WebAppFamily;
    expect(view.traditions.find((tradition) => tradition.id === ritual.id)).toMatchObject({ doneToday: true });

    const people = (await jointDecisionRepository.execute(familyGroup, { action: "participants" }, "people")).participants!;
    const decision = (await jointDecisionRepository.execute(familyGroup, {
      action: "create", partnerRef: people.find((person) => person.name === "Member")!.participantRef, title: "Отпуск в ноябре",
    }, "decision")).decision!;
    view = (await (await post("700102", { choice: "agree", nonce: randomUUID(), version: decision.version }, api.answer, { id: decision.id })).json()) as WebAppFamily;
    expect(view.decisions[0]).toMatchObject({ answered: true });

    view = (await (await post("700102", { endsAt: "12:00", nonce: randomUUID(), startsAt: "10:00", title: "Мастерская", weekday: 6 }, api.addTime)).json()) as WebAppFamily;
    const slot = view.time.mine[0]!;
    expect(slot).toMatchObject({ startsAt: "10:00", title: "Мастерская" });
    view = (await (await post("700102", { nonce: randomUUID() }, api.removeTime, { id: slot.id })).json()) as WebAppFamily;
    expect(view.time.mine).toEqual([]);
    expect((await post("700102", { endsAt: "25:00", nonce: randomUUID(), startsAt: "10:00", title: "x", weekday: 6 }, api.addTime)).status).toBe(400);
    // An every-day window sent again after a lost answer is not a second window.
    const daily = { endsAt: "07:00", nonce: randomUUID(), startsAt: "06:30", title: "Зарядка", weekday: null };
    await post("700102", daily, api.addTime);
    view = (await (await post("700102", daily, api.addTime)).json()) as WebAppFamily;
    expect(view.time.mine.filter((window) => window.title === "Зарядка")).toHaveLength(1);
  });

  it("tells the viewer's own mark of today from another member's, and names who marked it", async () => {
    await database().query("UPDATE users SET display_name = 'Юля Иванова' WHERE telegram_user_id = '700102'");
    const ritual = (await tasks.execute(owner, { action: "create", kind: "ritual", title: "Чай без телефонов" } as never, randomUUID(), { visibility: "family" })).task!;
    const marked = (await (await post("700102", { nonce: randomUUID() }, api.tradition, { id: ritual.id })).json()) as WebAppFamily;
    expect(marked.traditions.find((tradition) => tradition.id === ritual.id))
      .toMatchObject({ doneToday: true, doneTodayBy: ["Юля"], doneTodayByMe: true });
    const seen = (await read("700101")).traditions.find((tradition) => tradition.id === ritual.id);
    expect(seen).toMatchObject({ doneToday: false, doneTodayBy: ["Юля"], doneTodayByMe: false });
    expect(seen!.last).not.toBeNull();
  });
});
