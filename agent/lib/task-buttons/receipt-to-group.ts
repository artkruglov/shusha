/**
 * «В «Мама и Миша»» под квитанцией личной записи в личке (`GRP-09`, решение владельца 20 октября 2026).
 *
 * Exports:
 * - `RECEIPT_GROUPS_MAX`: сколько групп предлагает одна квитанция.
 * - `ToGroupDependencies`, `toGroupDependencies`: группа кнопки, живое участие в её чате, перенос и уборка кнопок.
 * - `liveGroupsOf`: обычные группы семьи, где человек сейчас в чате, для кнопок квитанции.
 * - `pressToGroup`: нажатие: право проверяется заново, запись переносится, кнопки этой записи уходят.
 *
 * Человек может записать в группу только туда, где он сейчас в чате: это проверяет Telegram (`getChatMember`) при
 * рисовании квитанции и ещё раз при нажатии, а база проверяет, что группа его семьи и обычная, а запись его личная и
 * касается только его (`sharedTaskVisibility.change`). Модель группу не выбирает. Из семьи и из группы в группу записи
 * не переносятся: семья состоит из нескольких групп, и у каждой свои записи.
 */
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { sharedTaskVisibility } from "../shared-task-visibility.js";
import { isCurrentTelegramMember, withTelegramMembershipCache } from "../telegram-current-membership.js";
import { taskButtonRepository, type TaskButtonRow } from "./task-button-repository.js";

/** Больше трёх строк превращают квитанцию в меню. */
export const RECEIPT_GROUPS_MAX = 3;
/** Сколько групп семьи проверяется в Telegram для одной квитанции. */
const GROUPS_CHECKED_MAX = 10;
/** Квитанция не ждёт Telegram дольше: опоздавшая группа просто не предлагается. */
const RECEIPT_GROUPS_DEADLINE_MS = 3_000;
/** Группа, куда пишут дела: обычная группа семьи с делами в её возможностях. */
const WRITABLE = "type = 'external' AND 'manage_shared_tasks' = ANY(tool_allowlist)";

export interface ToGroupDependencies {
  /** Группа кнопки, если она ещё обычная группа этой семьи. */
  targetGroup(familyId: string, groupId: string): Promise<{ telegramChatId: string; title: string } | null>;
  /** Состоит ли человек в чате сейчас; сбой Telegram значит «нет». */
  isGroupMember(telegramChatId: string, telegramUserId: string): Promise<boolean>;
  /** Личная запись уходит в группу на месте; повтор по ключу операции кнопки. */
  moveToGroup(auth: MemoryAuthorization, input: { groupId: string; id: string; version: number }, operationKey: string):
    Promise<{ id: string; title: string; version: number }>;
  /** Кнопки сообщения про эту запись: все, когда она ушла из лички, или только «В группу» (`only`), когда она стала общей. */
  removeForTask(ids: readonly string[], taskId: string, only?: "to_group"): Promise<void>;
}

export const toGroupDependencies: ToGroupDependencies = {
  async targetGroup(familyId, groupId) {
    const { rows } = await database().query<{ telegram_chat_id: string; title: string }>(
      `SELECT telegram_chat_id, title FROM telegram_groups WHERE id = $1 AND family_id = $2 AND ${WRITABLE}`,
      [groupId, familyId]);
    return rows[0] ? { telegramChatId: rows[0].telegram_chat_id, title: rows[0].title } : null;
  },
  isGroupMember: (chatId, userId) => isCurrentTelegramMember(chatId, userId),
  async moveToGroup(auth, input, operationKey) {
    const { task } = await sharedTaskVisibility.change(auth, input, operationKey);
    return { id: task.id, title: task.title, version: task.version };
  },
  removeForTask: (ids, taskId, only) => taskButtonRepository.removeForTask(ids, taskId, new Date(), only ?? null),
};

/**
 * Обычные группы семьи в порядке подключения, где человек сейчас в чате, если эту запись вообще можно туда перенести:
 * семья без пространств, запись личная, его, без области, подробностей и правок (как проверит `moveToGroup`). Не больше
 * `RECEIPT_GROUPS_MAX`; что не ответило за `RECEIPT_GROUPS_DEADLINE_MS`, не предлагается.
 */
export async function liveGroupsOf(
  familyId: string, telegramUserId: string, taskId: string, deadlineMs = RECEIPT_GROUPS_DEADLINE_MS,
): Promise<Array<{ id: string; title: string }>> {
  const { rows } = await database().query<{ id: string; telegram_chat_id: string; title: string }>(
    `SELECT g.id, g.telegram_chat_id, g.title FROM telegram_groups g
      WHERE g.family_id = $1 AND g.type = 'external' AND 'manage_shared_tasks' = ANY(g.tool_allowlist)
        AND NOT EXISTS (SELECT 1 FROM family_space_runtime r WHERE r.family_id = $1 AND r.mode <> 'legacy')
        AND EXISTS (SELECT 1 FROM shared_tasks t WHERE t.id = $3 AND t.family_id = $1 AND t.scope = 'personal'
              AND t.creator_telegram_id = $2 AND t.space_id IS NULL AND t.care_area_id IS NULL AND t.details IS NULL
              AND t.kind IN ('task', 'idea', 'ritual')
              AND NOT EXISTS (SELECT 1 FROM shared_task_versions v WHERE v.task_id = t.id))
      ORDER BY g.created_at, g.id LIMIT $4`,
    [familyId, telegramUserId, taskId, GROUPS_CHECKED_MAX]);
  if (rows.length === 0) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs); });
  const answers = rows.map(() => false);
  try {
    await Promise.race([withTelegramMembershipCache(() => Promise.all(rows.map(async (row, index) => {
      answers[index] = await isCurrentTelegramMember(row.telegram_chat_id, telegramUserId).catch(() => false);
    }))), late]);
  } finally {
    clearTimeout(timer);
  }
  return rows.filter((_, index) => answers[index]).slice(0, RECEIPT_GROUPS_MAX).map((row) => ({ id: row.id, title: row.title }));
}

/** Что ответить нажавшему; `alert` значит отказ, клавиатура тогда не перерисовывается. */
export async function pressToGroup(
  dependencies: ToGroupDependencies,
  input: {
    auth: MemoryAuthorization;
    /** Кнопки сообщения, с которого нажали. */
    ids: readonly string[];
    inFamily: <T>(work: () => Promise<T>) => Promise<T>;
    presserId: string;
    row: TaskButtonRow;
  },
): Promise<{ alert: boolean; text: string }> {
  const { auth, inFamily, row } = input;
  const group = await inFamily(() => dependencies.targetGroup(row.familyId, row.targetGroupId!));
  if (!group || !await dependencies.isGroupMember(group.telegramChatId, input.presserId)) {
    return { alert: true, text: "Записать в эту группу можно, только пока вы в её чате." };
  }
  const moved = await inFamily(() => dependencies.moveToGroup(
    auth, { groupId: row.targetGroupId!, id: row.taskId!, version: row.taskVersion! }, `button:${row.id}:${input.presserId}`));
  await inFamily(() => dependencies.removeForTask([...new Set([row.id, ...input.ids])], row.taskId!));
  console.info(JSON.stringify({ code: "AGENT_TASK_MOVED_TO_GROUP", groupId: row.targetGroupId, taskId: moved.id }));
  return { alert: false, text: `Теперь в группе «${group.title}»: ${moved.title}` };
}
