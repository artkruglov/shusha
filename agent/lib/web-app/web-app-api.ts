/**
 * The Mini App's API: the person's board, and one action on one task per tap.
 *
 * Exports:
 * - `WEB_APP_API_PREFIX`: where the routes live (nginx forwards only this prefix).
 * - `WEB_APP_TASK_ACTIONS`, `postponedTo`: the actions a tap may ask for, and the date «Перенести» sets.
 * - `WebAppTaskCreate`: what «Добавить дело» sends to the task repository.
 * - `authorizeWebApp`, `webAppJson`, `webAppFailure`, `readWebAppJson`, `webAppBadRequest`: the shared request
 *   path, also used by the «Ещё» routes (`web-app-more-api.ts`).
 * - `WebAppApiDependencies`, `createWebAppApi`: the handlers with injected dependencies, for tests.
 * - `webAppApiDependencies`, `webAppApi`: the same on the application database and the bot token.
 *
 * Identity comes only from Telegram's signature over `initData` (`init-data.ts`), sent as
 * `Authorization: tma <initData>`. From there it is the private chat path of a task button
 * (`privateChatAuthorization`): the family identity read live, the person's own scopes, work inside
 * the family's row-level scope. External groups' tasks are neither shown nor changed here
 * (`docs/telegram-mini-app-stories.ru.md`), though a private chat may show them. The request carries
 * only the task id, the action, its version and a nonce (and for «Перенести» which day); the task
 * repository decides whether this person may, exactly as for a chat turn. The
 * operation key `webapp:<user>:<nonce>` makes a repeated tap a replay, not a second change.
 *
 * The task card and «Закрытые» read the task through the same repository `get` first; only then
 * `web-app-queries.ts` adds its history, author and names, so a task the person may not see has no card.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { withFamilyDatabaseContext } from "../database-context.js";
import type { FamilyIdentity } from "../family-access.js";
import { dailyOverviewRepository } from "../initiative/daily-overview-repository.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { currentTimeRepository } from "../current-time-repository.js";
import { sharedTaskRepository } from "../shared-task-repository.js";
import { sharedTaskVisibility } from "../shared-task-visibility.js";
import { localDate } from "../task-board.js";
import {
  privateChatAuthorization,
  productionTaskButtonAuthorizer,
  type TaskButtonAuthorizer,
} from "../task-buttons/task-button-authorization.js";
import { telegramRepository } from "../telegram-repository.js";
import { verifiedWebAppUser } from "./init-data.js";
import { webAppBoard, type WebAppBoard } from "./web-app-board.js";
import { staleOfOverview } from "./web-app-stale.js";
import { webAppClosedWeek, weekOf, type WebAppClosedWeek } from "./web-app-closed.js";
import { webAppQueries } from "./web-app-queries.js";
import { webAppTaskCard, type PresentedTask, type WebAppTaskCard } from "./web-app-task-card.js";

export const WEB_APP_API_PREFIX = "/app-api";
const BODY_MAX_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NONCE = /^[A-Za-z0-9-]{8,64}$/u;

/** «Перенести» moves the date of the person's own task, never its time: tasks with a time have no button. */
export const WEB_APP_TASK_ACTIONS = ["accept", "accept_transfer", "cancel", "claim", "complete", "decline", "decline_transfer",
  "postpone", "release", "reopen", "share", "transfer", "unshare"] as const;
export type WebAppTaskAction = typeof WEB_APP_TASK_ACTIONS[number];
const POSTPONE_TO = ["today", "tomorrow", "weekend", "date"] as const;
type PostponeTo = Exclude<typeof POSTPONE_TO[number], "date">;
/** How far ahead a chosen date or a new task's date may be: a year, as the date picker offers. */
const DATE_AHEAD_DAYS = 366;
/** Longest title a tap may write, the same for a task, a tradition and an idea. */
export const WEB_APP_TITLE_MAX = 300;

/** The day in the person's calendar: «Выходные» is the next Saturday after today, a week on when it is Saturday. */
export function postponedTo(today: string, to: PostponeTo): string {
  const day = new Date(`${today}T00:00:00Z`);
  const ahead = to === "today" ? 0 : to === "tomorrow" ? 1 : (6 - day.getUTCDay() + 7) % 7 || 7;
  day.setUTCDate(day.getUTCDate() + ahead);
  return day.toISOString().slice(0, 10);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;

function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nearDays(today: string): string[] {
  return [-1, 0, 1].map((shift) => shiftDay(today, shift));
}

/** A chosen day: a real date, not before yesterday (the board may be a day old), not more than a year ahead. */
/** A day the person picked: a real date, from yesterday to the furthest the app offers. */
export function chosenDay(value: unknown, today: string): string {
  if (typeof value !== "string" || !ISO_DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) webAppBadRequest();
  if (value < shiftDay(today, -1) || value > shiftDay(today, DATE_AHEAD_DAYS)) webAppBadRequest();
  return value;
}

/** What goes to the task repository: «Перенести» is an `update` of the date, the rest are its own actions. */
export type WebAppTaskChange =
  | { action: Exclude<WebAppTaskAction, "postpone" | "share" | "transfer" | "unshare">; id: string; version: number }
  /** «Передать…»: a family task to a participant of the family, who answers it (`shared-task-handover.ts`). */
  | { action: "transfer"; assigneeRef: string; id: string; version: number }
  | { action: "visibility"; id: string; version: number; visibility: "family" | "personal" }
  | { action: "update"; dueOn: string; id: string; version: number };

/** «Добавить дело»: a title, and optionally a day, one of the person's projects and who sees it. */
export interface WebAppTaskCreate {
  action: "create";
  /** «Кому»: a participant of the family; another adult makes it a shared request (`shared-task-visibility.ts`). */
  assigneeRef?: string;
  dueOn?: string;
  projectRef?: string;
  title: string;
  /** «Для семьи / Только мне» on the form; without it the person's default decides, as in the chat. */
  visibility?: "family" | "personal";
  /** «Новая традиция» / «Когда-нибудь» on «Семья»: the same record of another kind, with no day, project or assignee. */
  kind?: "idea" | "ritual";
}

export interface WebAppTaskResult {
  id: string;
  status: string;
  title: string;
  version: number;
}

export interface WebAppApiDependencies {
  board(auth: MemoryAuthorization): Promise<WebAppBoard>;
  botToken(): string;
  /** «Кому»: the family as the private chat's task repository lists it, the person first. */
  participants(auth: MemoryAuthorization): Promise<Array<{ me: boolean; name: string; ref: string }>>;
  /** The task card: null when the repository does not give this person the task. */
  card(auth: MemoryAuthorization, id: string): Promise<WebAppTaskCard | null>;
  /** «Закрытые» for the week of the given day. */
  closed(auth: MemoryAuthorization, day: string): Promise<WebAppClosedWeek>;
  execute(auth: MemoryAuthorization, input: WebAppTaskChange | WebAppTaskCreate, operationKey: string): Promise<WebAppTaskResult>;
  findIdentity(telegramUserId: string): Promise<FamilyIdentity | null>;
  now(): Date;
  /** The person's today, in their own timezone. */
  today(auth: MemoryAuthorization): Promise<string>;
  turnSpace: TaskButtonAuthorizer["turnSpace"];
}

/** Status and the Russian message the page shows; the code goes to the log. */
const REFUSALS: Readonly<Record<string, number>> = {
  AGENT_ACCESS_DENIED: 403,
  AGENT_TASK_ACCESS_DENIED: 403,
  AGENT_TASK_VERSION_CONFLICT: 409,
  AGENT_PROJECT_VERSION_CONFLICT: 409,
  AGENT_PROJECT_DUPLICATE: 422,
  AGENT_PROJECT_HAS_OPEN_TASKS: 422,
  AGENT_PROJECT_INPUT_INVALID: 400,
  AGENT_WEB_APP_BAD_REQUEST: 400,
  AGENT_WEB_APP_NOT_FOUND: 404,
  AGENT_WEB_APP_HINT_LIMITED: 429,
  AGENT_WEB_APP_STUDIO_LIMITED: 429,
  AGENT_IMAGE_GENERATION_UNAVAILABLE: 503,
  AGENT_WEB_APP_UNAUTHORIZED: 401,
  AGENT_WEB_APP_GROUP_NO_INVITE_RIGHT: 422,
  AGENT_WEB_APP_VOICE_FORMAT: 415,
  AGENT_VOICE_FILE_TOO_LARGE: 413,
  AGENT_VOICE_TRANSCRIPT_EMPTY: 422,
  AGENT_VOICE_SERVICE_UNAVAILABLE: 503,
  AGENT_VOICE_TRANSCRIPTION_FAILED: 502,
  AGENT_VOICE_NOT_CONFIGURED: 503,
  AGENT_VOICE_BUSY: 503,
  AGENT_WEB_APP_VOICE_LIMITED: 429,
};

export function webAppJson(status: number, body: unknown): Response {
  return Response.json(body, { headers: { "cache-control": "no-store" }, status });
}

export function webAppFailure(error: unknown): Response {
  const code = error instanceof AppError ? error.code : "AGENT_WEB_APP_FAILED";
  const status = REFUSALS[code] ?? (code.startsWith("AGENT_TASK_") ? 422 : 500);
  // Only the code: initData, the body and the task title never reach the log.
  console.error(JSON.stringify({ code: "AGENT_WEB_APP_REQUEST_FAILED", errorCode: code, status }));
  const message = status === 500 || !(error instanceof AppError)
    ? "Не получилось. Попробуй ещё раз чуть позже."
    : error.message.replace(/^AGENT_[A-Z_]+: /u, "");
  return webAppJson(status, { code, message });
}

export function webAppBadRequest(): never {
  throw new AppError("AGENT_WEB_APP_BAD_REQUEST", "Неверный запрос");
}

export async function readWebAppJson(request: Request): Promise<Record<string, unknown> & { nonce: string }> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > BODY_MAX_BYTES) webAppBadRequest();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    webAppBadRequest();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) webAppBadRequest();
  const fields = body as Record<string, unknown>;
  if (typeof fields.nonce !== "string" || !NONCE.test(fields.nonce)) webAppBadRequest();
  return fields as Record<string, unknown> & { nonce: string };
}

async function readBody(request: Request): Promise<{
  assigneeRef: unknown; dueOn: unknown; nonce: string; on: unknown; to: unknown; version: number;
}> {
  const { assigneeRef, dueOn, nonce, on, to, version } = await readWebAppJson(request);
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) webAppBadRequest();
  return { assigneeRef, dueOn, nonce, on, to, version };
}

/** The person behind a signed `initData`, with the private chat's rights; 401 or 403 otherwise. */
export async function authorizeWebApp(
  request: Request,
  dependencies: Pick<WebAppApiDependencies, "botToken" | "findIdentity" | "now" | "turnSpace">,
): Promise<MemoryAuthorization> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("tma ")) throw new AppError("AGENT_WEB_APP_UNAUTHORIZED", "Открой доску заново из Telegram");
  const { telegramUserId } = verifiedWebAppUser(header.slice(4), dependencies.botToken(), dependencies.now());
  const identity = await dependencies.findIdentity(telegramUserId);
  if (!identity) {
    throw new AppError("AGENT_ACCESS_DENIED", "Доска есть только у участников семьи. Попроси владельца прислать приглашение");
  }
  return privateChatAuthorization(identity, telegramUserId, dependencies);
}

export function createWebAppApi(dependencies: WebAppApiDependencies) {
  const authorize = (request: Request) => authorizeWebApp(request, dependencies);

  async function change(auth: MemoryAuthorization, action: WebAppTaskAction, id: string, request: Request) {
    const { assigneeRef, dueOn, nonce, on, to, version } = await readBody(request);
    let input: WebAppTaskChange;
    if (action === "transfer") {
      if (typeof assigneeRef !== "string" || !UUID.test(assigneeRef)) webAppBadRequest();
      input = { action, assigneeRef, id, version };
    } else if (action === "postpone" && to === "date") {
      // A day the person picked: whether they may move this task's date is the repository's to decide.
      input = { action: "update", dueOn: chosenDay(dueOn, await dependencies.today(auth)), id, version };
    } else if (action === "postpone") {
      if (!POSTPONE_TO.includes(to as PostponeTo)) webAppBadRequest();
      // Counted from the day the board was read (`on`), not from now: the same tap replayed after midnight is
      // the same request. That day may differ from the person's today by one, never more.
      if (typeof on !== "string" || !ISO_DAY.test(on) || !nearDays(await dependencies.today(auth)).includes(on)) webAppBadRequest();
      input = { action: "update", dueOn: postponedTo(on, to as PostponeTo), id, version };
    } else if (action === "share" || action === "unshare") {
      input = { action: "visibility", id, version, visibility: action === "share" ? "family" : "personal" };
    } else {
      // A handover is answered with the version the card was read at too: a task changed since then is a
      // conflict, not an agreement to what the person never saw.
      input = { action, id, version };
    }
    // One nonce is one request: the same nonce with another action or day hashes differently, and the
    // repository refuses it instead of replaying the first.
    return dependencies.execute(auth, input, `webapp:${auth.userId}:${nonce}`);
  }

  async function create(auth: MemoryAuthorization, request: Request) {
    const { assigneeRef, dueOn, kind, nonce, projectRef, title, visibility } = await readWebAppJson(request);
    if (kind !== undefined && kind !== "idea" && kind !== "ritual") webAppBadRequest();
    if (kind !== undefined && (assigneeRef !== undefined || dueOn !== undefined || projectRef !== undefined)) webAppBadRequest();
    if (assigneeRef !== undefined && (typeof assigneeRef !== "string" || !UUID.test(assigneeRef))) webAppBadRequest();
    if (visibility !== undefined && visibility !== "family" && visibility !== "personal") webAppBadRequest();
    if (typeof title !== "string" || title.trim().length === 0 || Array.from(title.trim()).length > WEB_APP_TITLE_MAX) webAppBadRequest();
    if (projectRef !== undefined && (typeof projectRef !== "string" || !UUID.test(projectRef))) webAppBadRequest();
    const input: WebAppTaskCreate = {
      action: "create", title: title.trim(),
      ...(dueOn === undefined ? {} : { dueOn: chosenDay(dueOn, await dependencies.today(auth)) }),
      ...(projectRef === undefined ? {} : { projectRef: projectRef as string }),
      ...(assigneeRef === undefined ? {} : { assigneeRef: assigneeRef as string }),
      ...(visibility === undefined ? {} : { visibility }),
      ...(kind === undefined ? {} : { kind }),
    };
    return dependencies.execute(auth, input, `webapp:${auth.userId}:${nonce}`);
  }

  return {
    async board(request: Request): Promise<Response> {
      try {
        const auth = await authorize(request);
        return webAppJson(200, await withFamilyDatabaseContext(auth.familyId, () => dependencies.board(auth)));
      } catch (error) {
        return webAppFailure(error);
      }
    },
    async card(request: Request, params: Readonly<Record<string, string>>): Promise<Response> {
      try {
        const auth = await authorize(request);
        const id = params.id ?? "";
        if (!UUID.test(id)) webAppBadRequest();
        const card = await withFamilyDatabaseContext(auth.familyId, () => dependencies.card(auth, id));
        if (card === null) throw new AppError("AGENT_WEB_APP_NOT_FOUND", "Такого дела нет или оно недоступно");
        return webAppJson(200, { task: card });
      } catch (error) {
        return webAppFailure(error);
      }
    },
    async closed(request: Request): Promise<Response> {
      try {
        const auth = await authorize(request);
        const week = new URL(request.url).searchParams.get("week");
        const today = await dependencies.today(auth);
        // Any day of the wanted week; this week when none is given. Weeks ahead have nothing closed.
        const day = week ?? today;
        if (!ISO_DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) webAppBadRequest();
        if (day > today || day < shiftDay(today, -DATE_AHEAD_DAYS)) webAppBadRequest();
        return webAppJson(200, await withFamilyDatabaseContext(auth.familyId, () => dependencies.closed(auth, day)));
      } catch (error) {
        return webAppFailure(error);
      }
    },
    async participants(request: Request): Promise<Response> {
      try {
        const auth = await authorize(request);
        return webAppJson(200, { participants: await withFamilyDatabaseContext(auth.familyId, () => dependencies.participants(auth)) });
      } catch (error) {
        return webAppFailure(error);
      }
    },
    async create(request: Request): Promise<Response> {
      try {
        const auth = await authorize(request);
        const task = await withFamilyDatabaseContext(auth.familyId, () => create(auth, request));
        console.info(JSON.stringify({ action: "create", code: "AGENT_WEB_APP_TASK_CHANGED", taskId: task.id }));
        return webAppJson(200, { task });
      } catch (error) {
        return webAppFailure(error);
      }
    },
    async task(request: Request, params: Readonly<Record<string, string>>): Promise<Response> {
      try {
        const auth = await authorize(request);
        const id = params.id ?? "";
        const action = params.action ?? "";
        if (!UUID.test(id) || !(WEB_APP_TASK_ACTIONS as readonly string[]).includes(action)) webAppBadRequest();
        const task = await withFamilyDatabaseContext(auth.familyId, () => change(auth, action as WebAppTaskAction, id, request));
        console.info(JSON.stringify({ action, code: "AGENT_WEB_APP_TASK_CHANGED", taskId: id }));
        return webAppJson(200, { task });
      } catch (error) {
        return webAppFailure(error);
      }
    },
  };
}

function botToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new AppError("AGENT_TELEGRAM_BOT_TOKEN_MISSING", "Не задан TELEGRAM_BOT_TOKEN для доски");
  return token;
}

/** The task as the repository's `get` gives it to this person, or null: no rights, no task, or an external group's. */
async function visibleTask(auth: MemoryAuthorization, id: string): Promise<PresentedTask | null> {
  try {
    const result = await sharedTaskRepository.execute(auth, { action: "get", id } as never, `webapp-read:${id}`) as {
      task?: PresentedTask;
    };
    return result.task && result.task.scope !== "group" ? result.task : null;
  } catch (error) {
    // The repository answers a task that is not there and one that is not theirs alike.
    if (error instanceof AppError && error.code === "AGENT_TASK_ACCESS_DENIED") return null;
    throw error;
  }
}

async function timezoneOf(auth: MemoryAuthorization): Promise<string> {
  if (auth.userId === null) throw new AppError("AGENT_ACCESS_DENIED", "Нет доступа");
  return await currentTimeRepository.findTurnTimezone(auth.userId, auth.familyId) ?? "UTC";
}

/** A child in an area closes their own tasks but does not edit them, so «Перенести» would always be refused. */
async function canMove(auth: MemoryAuthorization): Promise<boolean> {
  const child = await database().query(
    "SELECT 1 FROM space_memberships WHERE family_id = $1 AND user_id = $2 AND state = 'active' AND role = 'child' LIMIT 1",
    [auth.familyId, auth.userId]);
  return child.rowCount === 0;
}

export const webAppApiDependencies: WebAppApiDependencies = {
  async board(auth) {
    // The board the morning overview and «Все дела» read: by the person's own identity.
    if (auth.userId === null || auth.telegramUserId === null) throw new AppError("AGENT_ACCESS_DENIED", "Нет доступа");
    const timezone = await timezoneOf(auth);
    const overview = await dailyOverviewRepository.overview({
      familyId: auth.familyId, settings: { timezone }, telegramUserId: auth.telegramUserId, userId: auth.userId,
    }, { withoutGroups: true });
    const today = localDate(timezone, overview.now);
    return { ...webAppBoard({
      now: overview.now, tasks: overview.tasks, timezone, waiting: overview.waiting,
      ...(overview.projects ? { projects: overview.projects } : {}),
    }, today, { canMove: await canMove(auth) }), stale: await staleOfOverview(auth.userId, overview.tasks, today) };
  },
  botToken,
  async participants(auth) {
    const result = await sharedTaskRepository.execute(auth, { action: "participants" } as never, "webapp-read") as {
      participants?: Array<{ name: string; participantRef: string }>;
    };
    const known = await webAppQueries.participantPeople(auth.familyId, (result.participants ?? []).map((person) => person.participantRef));
    return (result.participants ?? [])
      .map((person) => ({ me: known.get(person.participantRef) === auth.telegramUserId, name: person.name, ref: person.participantRef }))
      .sort((left, right) => Number(right.me) - Number(left.me) || left.name.localeCompare(right.name, "ru"));
  },
  async card(auth, id) {
    const task = await visibleTask(auth, id);
    if (task === null || auth.telegramUserId === null) return null;
    const facts = await webAppQueries.taskFacts(auth.familyId, id);
    if (facts === null) return null;
    const [history, names, timezone, movable] = await Promise.all([
      webAppQueries.history(auth.familyId, id), webAppQueries.names(auth.familyId), timezoneOf(auth), canMove(auth),
    ]);
    return webAppTaskCard(task, { ...facts, names, viewerTelegramId: auth.telegramUserId }, history,
      { canMove: movable, now: new Date(), timezone });
  },
  async closed(auth, day) {
    if (auth.telegramUserId === null) throw new AppError("AGENT_ACCESS_DENIED", "Нет доступа");
    const timezone = await timezoneOf(auth);
    const week = weekOf(day);
    const candidates = await webAppQueries.closed(auth.familyId, week, timezone);
    // Only what the repository gives this person: another member's personal task never appears. One read for all.
    const tasks = await webAppQueries.visibleTitles(auth, [...new Set(candidates.map((candidate) => candidate.taskId))]);
    return webAppClosedWeek(week, candidates, tasks,
      { names: await webAppQueries.names(auth.familyId), timezone, viewerTelegramId: auth.telegramUserId });
  },
  async execute(auth, input, operationKey) {
    if (input.action === "visibility") {
      const { task } = await sharedTaskVisibility.change(auth, input, operationKey);
      return { id: task.id, status: task.status, title: task.title, version: task.version };
    }
    // An external group's task stays in that group's chat, even when the person may change it from a private turn.
    let scope: string | undefined;
    if ("id" in input) {
      const current = await database().query<{ scope: string }>(
        "SELECT scope FROM shared_tasks WHERE id = $1 AND family_id = $2", [input.id, auth.familyId]);
      scope = current.rows[0]?.scope;
      if (scope === "group") {
        throw new AppError("AGENT_TASK_ACCESS_DENIED", "Дела внешних групп меняются в их чате");
      }
    }
    // Who sees a new task is the form's choice, passed beside the task's input: that schema is the model's, without it.
    let taskInput: unknown = input;
    let options: { visibility?: "family" | "personal" } = {};
    if (input.action === "create" && input.visibility !== undefined) {
      const { visibility, ...rest } = input;
      taskInput = rest;
      options = { visibility };
    }
    const result = await sharedTaskRepository.execute(auth, taskInput as never, operationKey, options) as {
      task?: { id?: string; status: string; title: string; version: number };
    };
    const id = result.task?.id ?? ("id" in input ? input.id : undefined);
    if (!result.task || !id) throw new AppError("AGENT_WEB_APP_FAILED", "Дело не вернулось после изменения");
    return { id, status: result.task.status, title: result.task.title, version: result.task.version };
  },
  findIdentity: (telegramUserId) => telegramRepository.findIdentity(telegramUserId),
  now: () => new Date(),
  today: async (auth) => localDate(await timezoneOf(auth), new Date()),
  turnSpace: productionTaskButtonAuthorizer.turnSpace,
};

export const webAppApi = createWebAppApi(webAppApiDependencies);
