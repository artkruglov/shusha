/**
 * Проекты в Mini App: список, страница проекта с шагами и то, что репозиторий проектов делает без модели
 * (`GET /app-api/projects`, `GET /app-api/projects/:id`, `POST /app-api/projects`, `POST /app-api/projects/:id/:action`).
 *
 * Exports:
 * - `WEB_APP_PROJECT_ACTIONS`: переименовать или описать, завершить, отменить, вернуть.
 * - `WebAppProjectsDependencies`, `createWebAppProjectsApi`: обработчики с подменяемыми зависимостями, для тестов.
 * - `webAppProjectsDependencies`, `webAppProjectsApi`: то же на базе приложения.
 *
 * Человек только из подписи `initData`, права лички (`authorizeWebApp`); что ему видно и что можно, решают
 * `projectRepository` и `sharedTaskRepository`, как для хода в личке. Шаг проекта это обычное дело с `projectRef`
 * (`POST /app-api/tasks`), поэтому своего маршрута у шага нет. Проект из лички, как и в чате, личный.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { withFamilyDatabaseContext } from "../database-context.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { projectRepository, type ProjectView } from "../projects/project-repository.js";
import { webAppQueries } from "./web-app-queries.js";
import {
  authorizeWebApp, readWebAppJson, webAppApiDependencies, webAppBadRequest, webAppFailure, webAppJson, WEB_APP_TITLE_MAX,
  type WebAppApiDependencies,
} from "./web-app-api.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const WEB_APP_PROJECT_ACTIONS = ["update", "complete", "cancel", "reopen"] as const;
type ProjectAction = typeof WEB_APP_PROJECT_ACTIONS[number];
/** Название проекта и описание: те же пределы, что у репозитория проектов. */
const PROJECT_TITLE_MAX = 100;
const PROJECT_DETAILS_MAX = 1000;
/** Сделанных шагов на странице: история, а не архив. */
const DONE_SHOWN = 10;

export interface WebAppProjectStep {
  /** What a tap may do on the row, by the same rules as the board: the repository still decides. */
  readonly actions: readonly string[];
  readonly assignee: string | null;
  readonly dueOn: string | null;
  readonly dueAt: string | null;
  /** `null`: the step is the project's, but its card is not this person's to open (another area of the family). */
  readonly id: string | null;
  readonly status: string;
  readonly title: string;
  readonly version: number;
}

export interface WebAppProjectsDependencies extends Pick<WebAppApiDependencies, "botToken" | "findIdentity" | "now" | "turnSpace"> {
  project(auth: MemoryAuthorization, input: Record<string, unknown>, operationKey: string): Promise<Record<string, unknown>>;
  /** Steps of a project the person sees: open ones by date, closed ones latest first. */
  steps(auth: MemoryAuthorization, projectId: string): Promise<{ done: WebAppProjectStep[]; open: WebAppProjectStep[] }>;
}

function notFound(): never {
  throw new AppError("AGENT_WEB_APP_NOT_FOUND", "Такого проекта нет или он недоступен");
}

interface StepRow {
  assignee: string | null; assignee_telegram_id: string | null; due_at: Date | null; due_on: string | null; id: string;
  status: string; title: string; version: number;
}

/** The board's rules for a row: one's own to close, an unowned one to take or close, a request to me to answer. */
function step(row: StepRow, viewer: string, openable: boolean): WebAppProjectStep {
  const mine = row.assignee_telegram_id === viewer;
  const actions = !openable ? []
    : row.status === "open" ? ["claim", "complete"]
    : row.status === "proposed" ? (mine ? ["accept", "decline"] : [])
    : row.status === "accepted" && mine ? ["complete"] : [];
  return {
    actions, assignee: row.assignee, dueAt: row.due_at?.toISOString() ?? null, dueOn: row.due_on, id: openable ? row.id : null,
    status: row.status, title: row.title, version: row.version,
  };
}

/**
 * Every step of the project the person sees: a family project's steps are the family's, a personal step only its own
 * people's. The project itself was found visible by `projectRepository` first; an external group's never is.
 */
async function projectSteps(auth: MemoryAuthorization, projectId: string) {
  const { rows } = await database().query<StepRow & { closed: boolean }>(
    `SELECT t.id, t.title, t.status, t.version, t.due_on::text AS due_on, t.due_at, t.assignee_telegram_id,
            CASE WHEN t.assignee_telegram_id IS NULL THEN NULL ELSE COALESCE(u.display_name, 'Участник') END AS assignee,
            t.status IN ('completed', 'cancelled', 'declined') AS closed
       FROM shared_tasks t LEFT JOIN users u ON u.telegram_user_id = t.assignee_telegram_id
      WHERE t.project_id = $1 AND t.family_id = $2 AND t.kind = 'task' AND t.scope <> 'group'
        AND (t.scope = 'family' OR t.creator_telegram_id = $3 OR t.assignee_telegram_id = $3)
        AND t.status IN ('open', 'proposed', 'accepted', 'completed')
      ORDER BY t.due_on NULLS LAST, t.due_at NULLS LAST, t.created_at, t.id`,
    [projectId, auth.familyId, auth.telegramUserId]);
  const viewer = auth.telegramUserId!;
  // A row opens the card and has buttons only where the card and the change read it too (`readTasks`): a family step
  // from another area of the family stood here as a link to «not found» (review of 23 October 2026).
  const openable = await webAppQueries.visibleTitles(auth, rows.map((row) => row.id));
  const done = rows.filter((row) => row.closed);
  return {
    // Latest closed first: «Сделано» is what moved lately.
    done: done.reverse().slice(0, DONE_SHOWN).map((row) => step(row, viewer, openable.has(row.id))),
    open: rows.filter((row) => !row.closed).map((row) => step(row, viewer, openable.has(row.id))),
  };
}

/** A project's own title, without the area the board appends («Ремонт (Семья)»). */
function shown(project: ProjectView) {
  return {
    completed: project.completed, details: project.details, id: project.id, open: project.open, scope: project.scope,
    status: project.status, title: project.title, total: project.total, version: project.version,
  };
}

export function createWebAppProjectsApi(dependencies: WebAppProjectsDependencies) {
  /** The person's projects as the repository gives them, without an external group's: those live in its chat. */
  async function projects(auth: MemoryAuthorization, includeClosed: boolean): Promise<ProjectView[]> {
    const result = await dependencies.project(auth, { action: "list", includeClosed }, "webapp-read");
    return ((result.projects as ProjectView[] | undefined) ?? []).filter((project) => project.scope !== "group");
  }

  function handle(work: (auth: MemoryAuthorization, request: Request) => Promise<unknown>) {
    return async (request: Request): Promise<Response> => {
      try {
        const auth = await authorizeWebApp(request, dependencies);
        return webAppJson(200, await withFamilyDatabaseContext(auth.familyId, () => work(auth, request)));
      } catch (error) {
        return webAppFailure(error);
      }
    };
  }

  return {
    list: handle(async (auth) => ({ projects: (await projects(auth, true)).map(shown) })),

    detail: (request: Request, params: Readonly<Record<string, string>>) => handle(async (auth) => {
      const id = params.id ?? "";
      if (!UUID.test(id)) webAppBadRequest();
      const project = (await projects(auth, true)).find((item) => item.id === id) ?? notFound();
      const { done, open } = await dependencies.steps(auth, project.id);
      return { done, project: shown(project), steps: open };
    })(request),

    /** «Новый проект»: a title and, as the repository asks, its first step; a retry is the same project. */
    create: handle(async (auth, request) => {
      const { nonce, step: first, title } = await readWebAppJson(request);
      if (typeof title !== "string" || title.trim().length === 0 || Array.from(title.trim()).length > PROJECT_TITLE_MAX) webAppBadRequest();
      if (first !== undefined && (typeof first !== "string" || first.trim().length === 0
        || Array.from(first.trim()).length > WEB_APP_TITLE_MAX)) webAppBadRequest();
      const result = await dependencies.project(auth, {
        action: "create", title: title.trim(), ...(typeof first === "string" ? { nextStep: { title: first.trim() } } : {}),
      }, `webapp:${auth.userId}:${nonce}`);
      const project = result.project as ProjectView | null;
      return { project: project ? shown(project) : null };
    }),

    change: (request: Request, params: Readonly<Record<string, string>>) => handle(async (auth, body) => {
      const id = params.id ?? "";
      const action = params.action ?? "";
      if (!UUID.test(id) || !(WEB_APP_PROJECT_ACTIONS as readonly string[]).includes(action)) webAppBadRequest();
      // Changed from here only if listed here: an external group's project is changed in its chat.
      if (!(await projects(auth, true)).some((item) => item.id === id)) notFound();
      const { details, nonce, title, version } = await readWebAppJson(body);
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) webAppBadRequest();
      const input: Record<string, unknown> = { action: action as ProjectAction, id, version };
      if (action === "update") {
        if (title !== undefined) {
          if (typeof title !== "string" || title.trim().length === 0 || Array.from(title.trim()).length > PROJECT_TITLE_MAX) webAppBadRequest();
          input.title = title.trim();
        }
        if (details !== undefined) {
          if (details !== null && (typeof details !== "string" || Array.from(details.trim()).length > PROJECT_DETAILS_MAX)) webAppBadRequest();
          input.details = typeof details === "string" && details.trim().length > 0 ? details.trim() : null;
        }
        if (!("title" in input) && !("details" in input)) webAppBadRequest();
      }
      const result = await dependencies.project(auth, input, `webapp:${auth.userId}:${nonce}`);
      const project = result.project as ProjectView | null;
      return { project: project ? shown(project) : null };
    })(request),
  };
}

export const webAppProjectsDependencies: WebAppProjectsDependencies = {
  ...webAppApiDependencies,
  project: (auth, input, operationKey) => projectRepository.execute(auth, input as never, operationKey) as Promise<Record<string, unknown>>,
  steps: projectSteps,
};

export const webAppProjectsApi = createWebAppProjectsApi(webAppProjectsDependencies);
