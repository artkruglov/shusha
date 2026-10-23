/**
 * Маршруты «Группы» Mini App: `GET /app-api/groups`, `GET /app-api/groups/:id`, `POST /app-api/groups/:id/tasks/:task/:action`
 * («Беру», «Сделано»), `POST /app-api/groups/:id/tasks` (дело, традиция или идея в группу, только участнику её чата)
 * и `POST /app-api/groups/:id/invite` (ссылка «Позвать людей», только владельцу).
 *
 * Exports:
 * - `WebAppGroupsDependencies`, `createWebAppGroupsApi`: обработчики с подменяемыми зависимостями, для тестов.
 * - `webAppGroupsApi`: то же на базе приложения и флаге `WEB_APP_GROUPS_ENABLED`.
 *
 * Без флага все маршруты отвечают 404 ещё до проверки `initData`, как будто их нет. Человек только из подписи
 * `initData`, права лички (`authorizeWebApp`), работа внутри семьи; права в самой группе строит `webAppGroups`.
 */
import { AppError } from "../app-error.js";
import { withFamilyDatabaseContext } from "../database-context.js";
import { WEB_APP_GROUPS_ENABLED } from "../groups-availability.js";
import { groupSetup } from "../group-join/group-setup.js";
import {
  authorizeWebApp, chosenDay, readWebAppJson, WEB_APP_TITLE_MAX, webAppApiDependencies, webAppBadRequest, webAppFailure, webAppJson, type WebAppApiDependencies,
} from "./web-app-api.js";
import { WEB_APP_GROUP_TASK_ACTIONS, webAppGroups, type WebAppGroupCreate, type WebAppGroupTaskAction } from "./web-app-groups.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface WebAppGroupsDependencies extends Pick<WebAppApiDependencies, "botToken" | "findIdentity" | "now" | "today" | "turnSpace"> {
  botUsername(): string | undefined;
  enabled: boolean;
  /** Новая ссылка с заявками в чат группы, null без права приглашать (`group-setup.ts`). */
  inviteLink(telegramChatId: string): Promise<string | null>;
  /** Срок списка; по умолчанию `GROUPS_LIST_DEADLINE_MS`. */
  listDeadlineMs?: number;
}

function notFound(): never {
  throw new AppError("AGENT_WEB_APP_NOT_FOUND", "Такой группы нет или она недоступна");
}

export function createWebAppGroupsApi(dependencies: WebAppGroupsDependencies) {
  return {
    async list(request: Request): Promise<Response> {
      try {
        if (!dependencies.enabled) notFound();
        const auth = await authorizeWebApp(request, dependencies);
        return webAppJson(200, await withFamilyDatabaseContext(auth.familyId,
          () => webAppGroups.list(auth, dependencies.turnSpace, dependencies.botUsername(), dependencies.listDeadlineMs)));
      } catch (error) {
        return webAppFailure(error);
      }
    },
    async detail(request: Request, params: Readonly<Record<string, string>>): Promise<Response> {
      try {
        if (!dependencies.enabled) notFound();
        const auth = await authorizeWebApp(request, dependencies);
        const id = params.id ?? "";
        if (!UUID.test(id)) webAppBadRequest();
        const group = await withFamilyDatabaseContext(auth.familyId, () => webAppGroups.detail(auth, id, dependencies.turnSpace));
        if (group === null) notFound();
        return webAppJson(200, group);
      } catch (error) {
        return webAppFailure(error);
      }
    },
    async task(request: Request, params: Readonly<Record<string, string>>): Promise<Response> {
      try {
        if (!dependencies.enabled) notFound();
        const auth = await authorizeWebApp(request, dependencies);
        const { id = "", task = "", action = "" } = params;
        if (!UUID.test(id) || !UUID.test(task) || !(WEB_APP_GROUP_TASK_ACTIONS as readonly string[]).includes(action)) webAppBadRequest();
        const { nonce, version } = await readWebAppJson(request);
        if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) webAppBadRequest();
        const changed = await withFamilyDatabaseContext(auth.familyId, () => webAppGroups.act(auth, id, task,
          { action: action as WebAppGroupTaskAction, version }, `webapp:${auth.userId}:${nonce}`, dependencies.turnSpace));
        if (changed === null) notFound();
        console.info(JSON.stringify({ action, code: "AGENT_WEB_APP_GROUP_TASK_CHANGED", groupId: id, taskId: task }));
        return webAppJson(200, { task: changed });
      } catch (error) {
        return webAppFailure(error);
      }
    },
    async create(request: Request, params: Readonly<Record<string, string>>): Promise<Response> {
      try {
        if (!dependencies.enabled) notFound();
        const auth = await authorizeWebApp(request, dependencies);
        const id = params.id ?? "";
        if (!UUID.test(id)) webAppBadRequest();
        const { assigneeRef, dueOn, kind, nonce, title, unassigned, ...rest } = await readWebAppJson(request);
        // Название и вид; у дела ещё срок и кому оно. Проект группы решается в её чате.
        if (Object.keys(rest).length > 0) webAppBadRequest();
        if (kind !== undefined && kind !== "idea" && kind !== "ritual") webAppBadRequest();
        if (typeof title !== "string" || title.trim().length === 0 || Array.from(title.trim()).length > WEB_APP_TITLE_MAX) webAppBadRequest();
        const task = kind === undefined;
        if (dueOn !== undefined && !task) webAppBadRequest();
        if (assigneeRef !== undefined && (!task || typeof assigneeRef !== "string" || !UUID.test(assigneeRef))) webAppBadRequest();
        if (unassigned !== undefined && (!task || unassigned !== true || assigneeRef !== undefined)) webAppBadRequest();
        const input: WebAppGroupCreate = {
          title: title.trim(), ...(kind === undefined ? {} : { kind }), ...(dueOn === undefined ? {} : { dueOn: chosenDay(dueOn, await dependencies.today(auth)) }),
          ...(assigneeRef === undefined ? {} : { assigneeRef }), ...(unassigned === undefined ? {} : { unassigned }),
        };
        const created = await withFamilyDatabaseContext(auth.familyId, () => webAppGroups.create(auth, id,
          input, `webapp:${auth.userId}:${nonce}`, dependencies.turnSpace));
        if (created === null) notFound();
        console.info(JSON.stringify({ code: "AGENT_WEB_APP_GROUP_TASK_CREATED", groupId: id, kind: kind ?? "task", taskId: created.id }));
        return webAppJson(200, { task: created });
      } catch (error) {
        return webAppFailure(error);
      }
    },
    async invite(request: Request, params: Readonly<Record<string, string>>): Promise<Response> {
      try {
        if (!dependencies.enabled) notFound();
        const auth = await authorizeWebApp(request, dependencies);
        const id = params.id ?? "";
        if (!UUID.test(id)) webAppBadRequest();
        const invite = await withFamilyDatabaseContext(auth.familyId, () => webAppGroups.invite(auth, id, dependencies.inviteLink));
        if (invite === null) notFound();
        if (invite.link === null) {
          throw new AppError("AGENT_WEB_APP_GROUP_NO_INVITE_RIGHT",
            "Чтобы звать людей, сделайте меня в группе администратором с правом приглашать участников.");
        }
        console.info(JSON.stringify({ code: "AGENT_WEB_APP_GROUP_INVITE_ISSUED", groupId: id }));
        return webAppJson(200, { link: invite.link });
      } catch (error) {
        return webAppFailure(error);
      }
    },
  };
}

export const webAppGroupsApi = createWebAppGroupsApi({
  ...webAppApiDependencies,
  botUsername: () => process.env.TELEGRAM_BOT_USERNAME,
  enabled: WEB_APP_GROUPS_ENABLED,
  inviteLink: (telegramChatId) => groupSetup.inviteLink(telegramChatId),
});
