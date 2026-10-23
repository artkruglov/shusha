/**
 * Маршруты вкладки «Семья» Mini App: сводка подхода и действия над областями заботы, традициями, решениями и личным
 * временем.
 *
 * Exports:
 * - `WebAppFamilyDependencies`, `createWebAppFamilyApi`: обработчики с подменяемыми зависимостями, для тестов.
 * - `webAppFamilyDependencies`, `webAppFamilyApi`: то же на базе приложения.
 *
 * Тот же путь запроса, что у доски: человек из подписи `initData`, права лички, работа внутри семьи. Тело несёт
 * id, версию, выбор и `nonce`; можно ли, решают репозитории (`web-app-family.ts`).
 */
import { withFamilyDatabaseContext } from "../database-context.js";
import type { MemoryAuthorization } from "../memory-context.js";
import {
  authorizeWebApp, readWebAppJson, webAppApiDependencies, webAppBadRequest, webAppFailure, webAppJson,
  type WebAppApiDependencies,
} from "./web-app-api.js";
import { webAppFamily, type WebAppFamily } from "./web-app-family.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/u;
const AREA_ACTIONS = ["accept", "claim", "decline", "propose", "release"] as const;
const WINDOW_TITLE_MAX = 100;

export interface WebAppFamilyDependencies extends Pick<WebAppApiDependencies, "botToken" | "findIdentity" | "now" | "today" | "turnSpace"> {
  read(auth: MemoryAuthorization, today: string): Promise<WebAppFamily>;
  markTradition(auth: MemoryAuthorization, id: string, today: string, operationKey: string): Promise<void>;
  area(auth: MemoryAuthorization, input: { action: typeof AREA_ACTIONS[number]; id: string; ownerRef?: string; version: number }): Promise<void>;
  answer(auth: MemoryAuthorization, input: { choice: "agree" | "decline"; id: string; version: number }, operationKey: string): Promise<void>;
  addTime(auth: MemoryAuthorization, input: { endsAt: string; startsAt: string; title: string; weekday: number | null }): Promise<void>;
  removeTime(auth: MemoryAuthorization, id: string): Promise<void>;
}

function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) webAppBadRequest();
  return value;
}

export function createWebAppFamilyApi(dependencies: WebAppFamilyDependencies) {
  /** Every change answers with the whole tab again: one round trip, and the page never redraws from a guess. */
  function handle(work: (auth: MemoryAuthorization, request: Request, params: Readonly<Record<string, string>>) => Promise<unknown>) {
    return async (request: Request, params: Readonly<Record<string, string>> = {}): Promise<Response> => {
      try {
        const auth = await authorizeWebApp(request, dependencies);
        return webAppJson(200, await withFamilyDatabaseContext(auth.familyId, async () => {
          await work(auth, request, params);
          return dependencies.read(auth, await dependencies.today(auth));
        }));
      } catch (error) {
        return webAppFailure(error);
      }
    };
  }
  const key = (auth: MemoryAuthorization, nonce: string) => `webapp:${auth.userId}:${nonce}`;
  const id = (params: Readonly<Record<string, string>>) => {
    if (!UUID.test(params.id ?? "")) webAppBadRequest();
    return params.id!;
  };

  return {
    read: handle(async () => undefined),
    tradition: handle(async (auth, request, params) => {
      const { nonce } = await readWebAppJson(request);
      await dependencies.markTradition(auth, id(params), await dependencies.today(auth), key(auth, nonce));
    }),
    area: handle(async (auth, request, params) => {
      const action = params.action ?? "";
      if (!(AREA_ACTIONS as readonly string[]).includes(action)) webAppBadRequest();
      const body = await readWebAppJson(request);
      if (action === "propose" && (typeof body.ownerRef !== "string" || !UUID.test(body.ownerRef))) webAppBadRequest();
      await dependencies.area(auth, {
        action: action as typeof AREA_ACTIONS[number], id: id(params), version: version(body.version),
        ...(action === "propose" ? { ownerRef: body.ownerRef as string } : {}),
      });
    }),
    answer: handle(async (auth, request, params) => {
      const { choice, nonce, version: raw } = await readWebAppJson(request);
      if (choice !== "agree" && choice !== "decline") webAppBadRequest();
      await dependencies.answer(auth, { choice, id: id(params), version: version(raw) }, key(auth, nonce));
    }),
    addTime: handle(async (auth, request) => {
      const { endsAt, startsAt, title, weekday } = await readWebAppJson(request);
      if (typeof startsAt !== "string" || !TIME.test(startsAt) || typeof endsAt !== "string" || !TIME.test(endsAt)) webAppBadRequest();
      if (typeof title !== "string" || title.trim().length === 0 || Array.from(title.trim()).length > WINDOW_TITLE_MAX) webAppBadRequest();
      if (weekday !== null && (typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 0 || weekday > 6)) webAppBadRequest();
      await dependencies.addTime(auth, { endsAt, startsAt, title: title.trim(), weekday: weekday as number | null });
    }),
    removeTime: handle(async (auth, request, params) => {
      await readWebAppJson(request);
      await dependencies.removeTime(auth, id(params));
    }),
  };
}

export const webAppFamilyDependencies: WebAppFamilyDependencies = {
  addTime: (auth, input) => webAppFamily.addTime(auth, input),
  answer: (auth, input, operationKey) => webAppFamily.answer(auth, input, operationKey),
  area: (auth, input) => webAppFamily.area(auth, input),
  botToken: webAppApiDependencies.botToken,
  findIdentity: webAppApiDependencies.findIdentity,
  markTradition: (auth, id, today, operationKey) => webAppFamily.markTradition(auth, id, today, operationKey),
  now: webAppApiDependencies.now,
  read: (auth, today) => webAppFamily.read(auth, today),
  removeTime: (auth, id) => webAppFamily.removeTime(auth, id),
  today: webAppApiDependencies.today,
  turnSpace: webAppApiDependencies.turnSpace,
};

export const webAppFamilyApi = createWebAppFamilyApi(webAppFamilyDependencies);
