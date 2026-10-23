/**
 * Mini App: tasks that have not moved for two weeks, one by one (docs/design/task-lists-v3.ru.md).
 *
 * Exports:
 * - `WebAppStaleDependencies`, `createWebAppStaleApi`, `webAppStaleDependencies`, `webAppStaleApi`: `GET /app-api/stale` and
 *   `POST /app-api/stale/:id/:action` with `week` or `keep`; «Сделано» and «Снять» are the ordinary task
 *   actions of `web-app-api.ts`.
 *
 * The list is the person's own board read by the same path as `/app-api/board` (`web-app-stale.ts`); the board
 * answer carries the same list for the home screen. «Через неделю» and «Оставить» are the same answers the chat
 * button gives (`stale-task-press.ts`), so the review and the message never differ. No model here (решение
 * 18 октября 2026): the hint «Спросить Шушу в чате» is a link the page opens, not a call.
 */
import { AppError } from "../app-error.js";
import { withFamilyDatabaseContext } from "../database-context.js";
import { dailyOverviewRepository } from "../initiative/daily-overview-repository.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { answerStaleTask, staleTaskPressDependencies, type StaleTaskPressDependencies } from "../task-buttons/stale-task-press.js";
import { staleOfOverview, type WebAppStaleTask } from "./web-app-stale.js";
import {
  authorizeWebApp, readWebAppJson, webAppApiDependencies, webAppBadRequest, webAppFailure, webAppJson,
  type WebAppApiDependencies,
} from "./web-app-api.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACTIONS = { keep: "keep", week: "postpone_week" } as const;

export interface WebAppStaleDependencies extends Pick<WebAppApiDependencies, "botToken" | "findIdentity" | "now" | "today" | "turnSpace"> {
  list(auth: MemoryAuthorization, today: string): Promise<WebAppStaleTask[]>;
  stale: StaleTaskPressDependencies;
}

export function createWebAppStaleApi(dependencies: WebAppStaleDependencies) {
  return {
    async list(request: Request): Promise<Response> {
      try {
        const auth = await authorizeWebApp(request, dependencies);
        return webAppJson(200, { tasks: await withFamilyDatabaseContext(auth.familyId,
          async () => dependencies.list(auth, await dependencies.today(auth))) });
      } catch (error) {
        return webAppFailure(error);
      }
    },
    async answer(request: Request, params: Readonly<Record<string, string>>): Promise<Response> {
      try {
        const auth = await authorizeWebApp(request, dependencies);
        const action = ACTIONS[params.action as keyof typeof ACTIONS];
        if (!action || !UUID.test(params.id ?? "")) webAppBadRequest();
        const { nonce, version } = await readWebAppJson(request);
        if (typeof version !== "number" || !Number.isInteger(version) || version < 1) webAppBadRequest();
        return webAppJson(200, await withFamilyDatabaseContext(auth.familyId, async () => {
          // Only a card of this review is answered here: the list leaves out external groups, whose tasks change in their
          // own chat (ревью 21 октября 2026). A card that left the list since is a conflict: the page reads it again.
          const today = await dependencies.today(auth);
          const current = (await dependencies.list(auth, today)).find((task) => task.id === params.id);
          if (!current || current.version !== version) throw new AppError("AGENT_TASK_VERSION_CONFLICT", "Это дело уже изменили");
          const line = await answerStaleTask(dependencies.stale, {
            action, auth, id: params.id!, now: dependencies.now(), operationKey: `webapp:${auth.userId}:${nonce}`, version,
          });
          return { line, tasks: await dependencies.list(auth, await dependencies.today(auth)) };
        }));
      } catch (error) {
        return webAppFailure(error);
      }
    },
  };
}

export const webAppStaleDependencies: WebAppStaleDependencies = {
  botToken: webAppApiDependencies.botToken,
  findIdentity: webAppApiDependencies.findIdentity,
  now: webAppApiDependencies.now,
  today: webAppApiDependencies.today,
  turnSpace: webAppApiDependencies.turnSpace,
  stale: staleTaskPressDependencies,
  async list(auth, today) {
    if (auth.userId === null || auth.telegramUserId === null) throw new AppError("AGENT_ACCESS_DENIED", "Нет доступа");
    const overview = await dailyOverviewRepository.overview({
      familyId: auth.familyId, settings: { timezone: "UTC" }, telegramUserId: auth.telegramUserId, userId: auth.userId,
    }, { withoutGroups: true });
    return staleOfOverview(auth.userId, overview.tasks, today);
  },
};

export const webAppStaleApi = createWebAppStaleApi(webAppStaleDependencies);

export type { WebAppStaleTask };
