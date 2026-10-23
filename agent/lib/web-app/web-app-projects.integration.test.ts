/**
 * Проекты Mini App на настоящей схеме: личность только из подписи `initData`, права из репозиториев проектов и дел.
 *
 * Constructs covered:
 * - «Новый проект» с первым шагом; повтор того же нажатия не заводит второй шаг.
 * - Страница проекта: шаги из репозитория дел этого проекта; шаг добавляется обычным делом с `projectRef`.
 * - Проект с открытыми шагами не завершается (422), устаревшая версия 409; отмена отвязывает шаги.
 * - Личный проект другого участника не виден (404).
 * - Шаги семейного проекта видны все, и чужие: кнопки и переход к карточке только там, где они сработают.
 * - Первый шаг личного проекта личный и в нём же, даже при выборе «для семьи» и одноимённом семейном проекте.
 * - Повтор изменения с тем же nonce после потерянного ответа получает проект, а не конфликт версии.
 */
import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { projectRepository } from "../projects/project-repository.js";
import { createTaskFamilyFixture } from "../shared-task.integration-fixtures.js";
import { createWebAppApi, webAppApiDependencies } from "./web-app-api.js";
import { createWebAppProjectsApi, webAppProjectsDependencies } from "./web-app-projects.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");

const TOKEN = "123456:web-app-projects-test";

function initData(telegramUserId: string): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ first_name: "Тест", id: Number(telegramUserId) }),
  };
  const check = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}

(enabled ? describe : describe.skip)("Mini App projects", () => {
  // The production wiring with only the token swapped.
  const api = createWebAppProjectsApi({ ...webAppProjectsDependencies, botToken: () => TOKEN });
  const tasks = createWebAppApi({ ...webAppApiDependencies, botToken: () => TOKEN });
  const headers = (who: string) => ({ authorization: `tma ${initData(who)}` });
  const post = (who: string, path: string, body: unknown) =>
    new Request(`https://x${path}`, { body: JSON.stringify(body), headers: headers(who), method: "POST" });
  const detail = async (who: string, id: string) =>
    api.detail(new Request(`https://x/app-api/projects/${id}`, { headers: headers(who) }), { id });

  let familyGroup: MemoryAuthorization;
  beforeEach(async () => {
    ({ familyGroup } = await createTaskFamilyFixture());
  });
  afterAll(closeDatabase);

  it("creates a project with its first step, adds a step, refuses to finish it while steps are open, and cancels it", async () => {
    const body = { nonce: randomUUID(), step: "Снять мерки", title: "Ремонт ванной" };
    const created = (await (await api.create(post("700101", "/app-api/projects", body))).json()) as { project: { id: string } };
    await api.create(post("700101", "/app-api/projects", body));
    let page = (await (await detail("700101", created.project.id)).json()) as {
      project: { open: number; title: string; version: number }; steps: Array<{ title: string }>;
    };
    expect(page.project).toMatchObject({ open: 1, title: "Ремонт ванной" });
    expect(page.steps.map((item) => item.title)).toEqual(["Снять мерки"]);

    const added = await tasks.create(post("700101", "/app-api/tasks", { nonce: randomUUID(), projectRef: created.project.id, title: "Выбрать плитку" }));
    expect(added.status).toBe(200);
    page = (await (await detail("700101", created.project.id)).json()) as typeof page;
    expect(page.steps.map((item) => item.title).sort()).toEqual(["Выбрать плитку", "Снять мерки"]);

    const finish = (version: number) => api.change(
      post("700101", `/app-api/projects/${created.project.id}/complete`, { nonce: randomUUID(), version }),
      { action: "complete", id: created.project.id });
    expect((await finish(page.project.version)).status).toBe(422);
    expect((await finish(page.project.version + 5)).status).toBe(409);
    const renamed = await api.change(
      post("700101", `/app-api/projects/${created.project.id}/update`, { details: "Плитка и сантехника", nonce: randomUUID(), title: "Ванная", version: page.project.version }),
      { action: "update", id: created.project.id });
    const after = ((await renamed.json()) as { project: { details: string; title: string; version: number } }).project;
    expect(after).toMatchObject({ details: "Плитка и сантехника", title: "Ванная" });
    const cancelled = await api.change(
      post("700101", `/app-api/projects/${created.project.id}/cancel`, { nonce: randomUUID(), version: after.version }),
      { action: "cancel", id: created.project.id });
    expect(((await cancelled.json()) as { project: { status: string } }).project.status).toBe("cancelled");

    // Another member does not see a personal project at all.
    expect((await detail("700102", created.project.id)).status).toBe(404);
    expect((await api.change(post("700101", `/app-api/projects/${created.project.id}/delete`, { nonce: randomUUID(), version: 1 }),
      { action: "delete", id: created.project.id })).status).toBe(400);
  });

  it("shows every step of a family project, another member's too, with buttons only where they work", async () => {
    const made = await projectRepository.execute(familyGroup, { action: "create", nextStep: { title: "Купить краску" }, title: "Дача" } as never, randomUUID()) as {
      nextStep: { id: string }; project: { id: string };
    };
    await database().query("UPDATE shared_tasks SET assignee_telegram_id='700102', status='accepted' WHERE id=$1", [made.nextStep.id]);
    const page = (await (await detail("700101", made.project.id)).json()) as { steps: Array<{ actions: string[]; assignee: string; id: string | null; title: string }> };
    expect(page.steps).toEqual([expect.objectContaining({ actions: [], title: "Купить краску" })]);
    const theirs = (await (await detail("700102", made.project.id)).json()) as { steps: Array<{ actions: string[]; id: string | null }> };
    expect(theirs.steps[0]!.actions).toEqual(["complete"]);
    const card = await tasks.card(new Request(`https://x/app-api/tasks/${theirs.steps[0]!.id}`, { headers: headers("700102") }),
      { id: theirs.steps[0]!.id! });
    expect(card.status).toBe(200);
  });

  it("shows another member's family step as a row without a link where its card would not open", async () => {
    // Ревью 23 октября 2026: страница проекта вела на карточку, которая из лички отвечала 404.
    const made = await projectRepository.execute(familyGroup, { action: "create", nextStep: { title: "Свой шаг владельца" }, title: "Гараж" } as never, randomUUID()) as {
      nextStep: { id: string }; project: { id: string };
    };
    const page = (await (await detail("700102", made.project.id)).json()) as { steps: Array<{ actions: string[]; id: string | null; title: string }> };
    expect(page.steps).toEqual([expect.objectContaining({ actions: [], id: null, title: "Свой шаг владельца" })]);
    const card = await tasks.card(new Request(`https://x/app-api/tasks/${made.nextStep.id}`, { headers: headers("700102") }), { id: made.nextStep.id });
    expect(card.status).toBe(404);
    const own = (await (await detail("700101", made.project.id)).json()) as { steps: Array<{ id: string | null }> };
    expect(own.steps[0]!.id).toBe(made.nextStep.id);
  });

  it("keeps a personal project's first step personal and in it, whatever ordinary tasks default to", async () => {
    await projectRepository.execute(familyGroup, { action: "create", title: "Ремонт" } as never);
    const owner = (await database().query("SELECT id FROM users WHERE telegram_user_id='700101'")).rows[0].id;
    await database().query("INSERT INTO user_notification_settings(user_id,timezone,default_task_visibility) VALUES($1,'UTC','family')", [owner]);
    const response = await api.create(post("700101", "/app-api/projects", { nonce: randomUUID(), step: "Личный шаг", title: "Ремонт" }));
    expect(response.status).toBe(200);
    const created = ((await response.json()) as { project: { id: string; scope: string } }).project;
    expect(created.scope).toBe("personal");
    const { rows } = await database().query("SELECT scope, project_id FROM shared_tasks WHERE kind='task' AND title='Личный шаг'");
    expect(rows).toEqual([{ project_id: created.id, scope: "personal" }]);
  });

  it("answers a change replayed with its nonce after a lost answer with the project, not a version conflict", async () => {
    const made = await projectRepository.execute(familyGroup, { action: "create", title: "Сад" } as never) as { project: { id: string; version: number } };
    const body = { nonce: randomUUID(), title: "Огород", version: made.project.version };
    const change = () => api.change(post("700101", `/app-api/projects/${made.project.id}/update`, body), { action: "update", id: made.project.id });
    expect((await change()).status).toBe(200);
    const replay = await change();
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { project: { title: string; version: number } }).project)
      .toMatchObject({ title: "Огород", version: made.project.version + 1 });
    // The same nonce with another request is still refused.
    expect((await api.change(post("700101", `/app-api/projects/${made.project.id}/update`, { ...body, title: "Иное" }),
      { action: "update", id: made.project.id })).status).not.toBe(200);
  });
});
