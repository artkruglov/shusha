/**
 * «Группы» Mini App (MVP-1): группы семьи, где человек сейчас состоит, и дела с традициями одной из них, только чтение.
 *
 * Exports:
 * - `WebAppGroupSummary`, `WebAppGroupsList`, `WebAppGroupDetail`: то, что получает страница.
 * - `WebAppGroupTaskAction`: «Беру» и «Сделано» на странице группы.
 * - `webAppGroups`: список, одна группа, действие с её делом, запись в неё и ссылка «Позвать людей»; `turnSpace`
 *   подаётся снаружи, как у доски.
 *
 * Права в группе строит сервер, как их получил бы ход в её чате (`family-access.ts`): внешняя группа только своя
 * область `group`, семейная только `family`, человек и роль из `initData` и базы. Чтение идёт через
 * `sharedTaskRepository`, затем строки ещё раз сверяются с областью группы: личное и семейное через внешнюю
 * группу не уходит. Состав чата проверяется живым `getChatMember` не больше чем для десяти групп, по одному
 * разу на группу за запрос (`withTelegramMembershipCache`): повторная проверка репозитория берёт тот же ответ и
 * не держит транзакцию на Telegram. Ошибка Telegram значит «не показывать». Группы другой семьи и группы без
 * семьи не читаются вовсе.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { groupCreateLink } from "../groups-availability.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { sharedTaskRepository } from "../shared-task-repository.js";
import type { TaskButtonAuthorizer } from "../task-buttons/task-button-authorization.js";
import { isCurrentTelegramMember, withTelegramMembershipCache } from "../telegram-current-membership.js";

/** Сколько групп за запрос проверяется в Telegram; как у `keepLiveGroupRows`. */
const GROUPS_CHECKED_MAX = 10;
/** Сколько групп списка читается одновременно. */
const GROUPS_CONCURRENCY = 4;
/** Сколько ждёт список, прежде чем ответить без недочитанных групп. */
export const GROUPS_LIST_DEADLINE_MS = 8_000;
/** Страниц репозитория (по 100) на один вид записей группы; дальше `truncated`/`more`. */
export const GROUP_PAGES_MAX = 5;

export interface WebAppGroupSummary {
  readonly id: string;
  readonly title: string;
  /** `family`: семейная группа (`family_private`), `group`: обычная группа семьи (`external`). */
  readonly kind: "family" | "group";
  readonly openTasks: number;
  readonly traditions: number;
  /** Записей больше, чем прочитано: счётчики это «не меньше». */
  readonly more: boolean;
  /** Сюда можно записать из приложения: обычная группа с делами в её возможностях (`GRP-09`). */
  readonly writable: boolean;
}

export interface WebAppGroupsList {
  readonly groups: readonly WebAppGroupSummary[];
  /** Ссылка «Создать группу» (`?startgroup=group`), только владельцу. */
  readonly createLink: string | null;
  /** Не все группы успели проверить к сроку: показаны только успевшие. */
  readonly partial: boolean;
}

export interface WebAppGroupDetail {
  readonly title: string;
  readonly kind: "family" | "group";
  /** `due`: день `YYYY-MM-DD` или момент ISO, null без срока. */
  readonly tasks: ReadonlyArray<{
    id: string; title: string; due: string | null; assignee: string | null; version: number;
    readonly actions: readonly WebAppGroupTaskAction[];
  }>;
  /** `last`: день последней отметки `YYYY-MM-DD`, null если не отмечали. */
  readonly traditions: ReadonlyArray<{ title: string; last: string | null }>;
  /** Записей больше, чем показано. */
  readonly truncated: boolean;
  /** Кнопка «Позвать людей»: владельцу в обычной группе. */
  readonly canInvite: boolean;
  /** «+ Дело» отсюда (`GRP-09`), и кому его можно дать: люди, которых Шуша видела в чате группы. */
  readonly writable: boolean;
  readonly participants: ReadonlyArray<{ ref: string; name: string; me: boolean }>;
}

/** Запись в группу: дело может нести срок и того, кому оно (участник чата), или быть ничьим. */
export type WebAppGroupCreate = {
  title: string; kind?: "idea" | "ritual"; dueOn?: string; assigneeRef?: string; unassigned?: true;
};

export const WEB_APP_GROUP_TASK_ACTIONS = ["claim", "complete"] as const;
export type WebAppGroupTaskAction = typeof WEB_APP_GROUP_TASK_ACTIONS[number];

interface GroupRow {
  id: string;
  telegram_chat_id: string;
  title: string;
  tool_allowlist: string[];
  type: "external" | "family_private";
}

type Listed = {
  id: string; title: string; kind: string; dueOn: string | null; dueAt: string | null; assignee: string | null;
  status?: string; version?: number;
};

/**
 * Кому дать дело группы: репозиторий отдаёт людей, которых видел в журнале этого чата; «я» по своей строке.
 * Отдать другому всё равно проверит `create` живым составом чата.
 */
async function groupParticipants(viewer: MemoryAuthorization, group: GroupRow, turnSpace: TurnSpace) {
  const auth = await groupAuthorization(viewer, group, turnSpace);
  const { participants } = await sharedTaskRepository.execute(auth, { action: "participants" } as never, "webapp-read") as {
    participants: Array<{ participantRef: string; name: string }>;
  };
  const mine = await database().query<{ id: string }>(
    "SELECT id FROM shared_task_participants WHERE family_id = $1 AND group_id = $2 AND telegram_user_id = $3",
    [viewer.familyId, group.id, viewer.telegramUserId]);
  const me = mine.rows[0]?.id;
  return participants.map((person) => ({ me: person.participantRef === me, name: person.name, ref: person.participantRef }));
}

/** Ничьё дело можно взять или закрыть, взятое только закрыть; предложенное решают в чате. */
function actionsOf(task: Listed): WebAppGroupTaskAction[] {
  if (typeof task.version !== "number") return [];
  if (task.status === "open") return ["claim", "complete"];
  return task.status === "accepted" ? ["complete"] : [];
}

/** Записи группы и признак, что за пределом страниц остались ещё. */
type Records = { items: Listed[]; truncated: boolean };

type TurnSpace = TaskButtonAuthorizer["turnSpace"];

/** Группы семьи человека в порядке подключения, без проверки состава чата. */
async function familyGroups(viewer: MemoryAuthorization, id: string | null = null): Promise<GroupRow[]> {
  if (viewer.telegramUserId === null) throw new AppError("AGENT_ACCESS_DENIED", "Нет доступа");
  const rows = await database().query<GroupRow>(
    `SELECT id, telegram_chat_id, title, tool_allowlist, type FROM telegram_groups
      WHERE family_id = $1 AND type IN ('external', 'family_private') AND ($2::uuid IS NULL OR id = $2::uuid)
      ORDER BY created_at, id LIMIT $3`,
    [viewer.familyId, id, GROUPS_CHECKED_MAX]);
  return rows.rows;
}

/** Состоит ли человек в чате группы сейчас; сбой Telegram значит «нет». Вне транзакции базы. */
async function isLive(viewer: MemoryAuthorization, group: GroupRow): Promise<boolean> {
  try {
    return await isCurrentTelegramMember(group.telegram_chat_id, viewer.telegramUserId!);
  } catch {
    return false;
  }
}

/** Права хода в чате этой группы: те же, что дал бы `evaluateConversationAccess` участнику той же семьи. */
async function groupAuthorization(viewer: MemoryAuthorization, group: GroupRow, turnSpace: TurnSpace): Promise<MemoryAuthorization> {
  const space = await turnSpace({ familyId: viewer.familyId, groupId: group.id, userId: viewer.userId! });
  return {
    ...(space ? { space } : {}),
    familyId: viewer.familyId,
    groupId: group.id,
    role: viewer.role,
    scopes: group.type === "external" ? ["group"] : ["family"],
    telegramActorId: viewer.telegramUserId!,
    telegramActorKind: "telegram_user",
    telegramUserId: viewer.telegramUserId,
    userId: viewer.userId,
  };
}

/** Незакрытые записи вида `view` по страницам репозитория, не больше `GROUP_PAGES_MAX` страниц. */
async function readPages(auth: MemoryAuthorization, view: "rituals" | undefined): Promise<Records> {
  const items: Listed[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < GROUP_PAGES_MAX; page += 1) {
    const input = { action: "list", ...(view ? { view } : {}), ...(cursor ? { cursor } : {}) };
    const result = await sharedTaskRepository.execute(auth, input as never, "webapp-read") as {
      nextCursor?: string | null; tasks?: Listed[];
    };
    items.push(...(result.tasks ?? []));
    cursor = result.nextCursor ?? null;
    if (cursor === null) return { items, truncated: false };
  }
  return { items, truncated: true };
}

/**
 * Незакрытые дела и традиции группы, как их отдаёт репозиторий её чату, и только её области. Традиции читаются
 * своим видом, чтобы идеи и дела не вытесняли их со страниц.
 */
async function groupRecords(viewer: MemoryAuthorization, group: GroupRow, turnSpace: TurnSpace): Promise<{ rituals: Records; tasks: Records }> {
  const auth = await groupAuthorization(viewer, group, turnSpace);
  let read: { rituals: Records; tasks: Records };
  try {
    const all = await readPages(auth, undefined);
    read = {
      rituals: await readPages(auth, "rituals"),
      tasks: { items: all.items.filter((task) => task.kind === "task"), truncated: all.truncated },
    };
  } catch (error) {
    // Внешняя группа без дел в своих возможностях: репозиторий отказывает, а дел у неё просто нет.
    if (error instanceof AppError && error.code === "AGENT_TASK_ACCESS_DENIED") {
      return { rituals: { items: [], truncated: false }, tasks: { items: [], truncated: false } };
    }
    throw error;
  }
  const ids = [...read.tasks.items, ...read.rituals.items].map((task) => task.id);
  const scoped = ids.length === 0 ? { rows: [] } : await database().query<{ id: string }>(
    `SELECT id FROM shared_tasks WHERE family_id = $1 AND id = ANY($2::uuid[]) AND scope = $3
        AND group_id IS NOT DISTINCT FROM $4::uuid`,
    [viewer.familyId, ids, group.type === "external" ? "group" : "family", group.type === "external" ? group.id : null]);
  const allowed = new Set(scoped.rows.map((row) => row.id));
  const keep = (records: Records): Records => ({ items: records.items.filter((task) => allowed.has(task.id)), truncated: records.truncated });
  return { rituals: keep(read.rituals), tasks: keep(read.tasks) };
}

const writable = (group: GroupRow): boolean => group.type === "external" && group.tool_allowlist.includes("manage_shared_tasks");

const kindOf = (group: GroupRow): "family" | "group" => group.type === "external" ? "group" : "family";

/** Сводка одной группы, или null, если человек в ней больше не состоит. */
async function summary(viewer: MemoryAuthorization, group: GroupRow, turnSpace: TurnSpace): Promise<WebAppGroupSummary | null> {
  if (!await isLive(viewer, group)) return null;
  const { rituals, tasks } = await groupRecords(viewer, group, turnSpace);
  return {
    id: group.id, kind: kindOf(group), more: tasks.truncated || rituals.truncated,
    openTasks: tasks.items.length, title: group.title, traditions: rituals.items.length, writable: writable(group),
  };
}

export const webAppGroups = {
  /**
   * Группы читаются по `GROUPS_CONCURRENCY` одновременно; что не успело к `deadlineMs`, в ответ не попадает
   * (`partial: true`), а не ждёт. Начатое чтение доходит само и отбрасывается.
   */
  list(viewer: MemoryAuthorization, turnSpace: TurnSpace, botUsername: string | undefined,
    deadlineMs = GROUPS_LIST_DEADLINE_MS): Promise<WebAppGroupsList> {
    return withTelegramMembershipCache(async () => {
      const groups = await familyGroups(viewer);
      const results: Array<WebAppGroupSummary | null | undefined> = groups.map(() => undefined);
      let next = 0;
      const worker = async () => {
        while (next < groups.length) {
          const index = next;
          next += 1;
          results[index] = await summary(viewer, groups[index]!, turnSpace);
        }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, deadlineMs); });
      try {
        await Promise.race([Promise.all(Array.from({ length: Math.min(GROUPS_CONCURRENCY, groups.length) }, worker)), deadline]);
      } finally {
        clearTimeout(timer);
      }
      // Снимок на момент ответа: группа, дочитанная позже, сюда уже не попадёт.
      const settled = [...results];
      return {
        createLink: viewer.role === "owner" ? groupCreateLink(botUsername) : null,
        groups: settled.filter((group): group is WebAppGroupSummary => group != null),
        partial: settled.some((group) => group === undefined),
      };
    });
  },

  /** Null, если такой группы нет у семьи человека или он в ней больше не состоит. */
  detail(viewer: MemoryAuthorization, id: string, turnSpace: TurnSpace): Promise<WebAppGroupDetail | null> {
    return withTelegramMembershipCache(async () => {
      const group = (await familyGroups(viewer, id))[0];
      if (!group || !await isLive(viewer, group)) return null;
      const { rituals, tasks } = await groupRecords(viewer, group, turnSpace);
      const occurrences = rituals.items.length === 0 ? { rows: [] } : await database().query<{ task_id: string; last: string }>(
        "SELECT task_id, max(occurred_on)::text AS last FROM shared_ritual_occurrences WHERE task_id = ANY($1::uuid[]) GROUP BY task_id",
        [rituals.items.map((task) => task.id)]);
      const lastOf = new Map(occurrences.rows.map((row) => [row.task_id, row.last]));
      return {
        canInvite: viewer.role === "owner" && group.type === "external",
        kind: kindOf(group),
        participants: writable(group) ? await groupParticipants(viewer, group, turnSpace) : [],
        tasks: tasks.items.map((task) => ({
          actions: actionsOf(task), assignee: task.assignee, due: task.dueOn ?? task.dueAt, id: task.id, title: task.title,
          version: task.version ?? 0,
        })),
        title: group.title,
        traditions: rituals.items.map((task) => ({ last: lastOf.get(task.id) ?? null, title: task.title })),
        truncated: tasks.truncated || rituals.truncated,
        writable: writable(group),
      };
    });
  },

  /**
   * «Беру» или «Сделано» с делом группы: права хода в её чате, только живому участнику чата и только дело этой
   * группы. Null, если группы или дела у человека нет. Повтор с тем же `operationKey` не меняет дело дважды.
   */
  act(viewer: MemoryAuthorization, id: string, taskId: string, change: { action: WebAppGroupTaskAction; version: number },
    operationKey: string, turnSpace: TurnSpace): Promise<{ id: string; version: number } | null> {
    return withTelegramMembershipCache(async () => {
      const group = (await familyGroups(viewer, id))[0];
      if (!group || !await isLive(viewer, group)) return null;
      const own = await database().query(
        `SELECT 1 FROM shared_tasks WHERE id = $1 AND family_id = $2 AND scope = $3 AND group_id IS NOT DISTINCT FROM $4::uuid`,
        [taskId, viewer.familyId, group.type === "external" ? "group" : "family", group.type === "external" ? group.id : null]);
      if ((own.rowCount ?? 0) === 0) return null;
      const auth = await groupAuthorization(viewer, group, turnSpace);
      const result = await sharedTaskRepository.execute(auth, { action: change.action, id: taskId, version: change.version } as never,
        operationKey) as { task?: { id: string; version: number } };
      if (!result.task) throw new AppError("AGENT_TASK_BUTTON_RESULT_MISSING", "Дело не вернулось после изменения");
      return { id: result.task.id, version: result.task.version };
    });
  },

  /**
   * Обычная группа семьи и её владелец, который сейчас в её чате: кому из них звать людей. Ссылку выпускает
   * `issue` (бот в Telegram); null от него значит, что у бота нет права приглашать.
   */
  invite(viewer: MemoryAuthorization, id: string, issue: (telegramChatId: string) => Promise<string | null>):
    Promise<{ link: string | null } | null> {
    return withTelegramMembershipCache(async () => {
      if (viewer.role !== "owner") return null;
      const group = (await familyGroups(viewer, id))[0];
      if (!group || group.type !== "external" || !await isLive(viewer, group)) return null;
      return { link: await issue(group.telegram_chat_id) };
    });
  },

  /**
   * Запись в обычную группу из приложения (`GRP-09`, решение владельца 20 октября): только в группу своей семьи, где
   * человек сейчас в чате, с правами хода в её чате. Семейная группа сюда не идёт: «Вся семья» пишется как обычно.
   * Null, если такой группы у человека нет.
   */
  create(viewer: MemoryAuthorization, id: string, input: WebAppGroupCreate,
    operationKey: string, turnSpace: TurnSpace): Promise<{ id: string; title: string } | null> {
    return withTelegramMembershipCache(async () => {
      const group = (await familyGroups(viewer, id))[0];
      if (!group || !writable(group) || !await isLive(viewer, group)) return null;
      const auth = await groupAuthorization(viewer, group, turnSpace);
      const result = await sharedTaskRepository.execute(auth, { action: "create", ...input } as never, operationKey) as {
        task?: { id: string; title: string };
      };
      if (!result.task) throw new AppError("AGENT_TASK_BUTTON_RESULT_MISSING", "Запись не вернулась после создания");
      return { id: result.task.id, title: result.task.title };
    });
  },
};
