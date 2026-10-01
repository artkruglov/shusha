/**
 * Блок `<task_projects>`: проекты этой области в контексте хода, чтобы агент выбирал сам.
 *
 * Exports:
 * - `formatTaskProjectsContext`: текст блока по проектам.
 * - `buildTaskProjectsContext`: блок для проверенного хода или `null`, если его не нужно.
 *
 * Агент решает смыслом, к какому проекту относится дело, нужен ли новый и не дублируют ли проекты друг
 * друга. Для этого он должен видеть проекты, а не угадывать названия (в эвале 1 октября 2026 модель сама
 * придумывала списки «Дом» и «Покупки» для «купить батарейки»). Блок строго по области хода: тот же
 * `authorize` и `readProjects`, что у инструмента, поэтому в семейной группе нет личных проектов, а у
 * другого человека нет чужих. Блок это справка, а не задание: в прошлый раз список имён в *ответе*
 * инструмента бот читал как команду «спроси, куда положить», поэтому пометка в нём говорит обратное.
 */
import { database } from "../database.js";
import type { ConversationAccess } from "../family-access.js";
import { lifeAreaTitle } from "../life-areas.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { authorize, readProjects, type ProjectListing } from "../shared-task-access.js";
import type { TelegramActorKind } from "../telegram-inbound-actor.js";

const MAX_PROJECTS = 15;
const MAX_CHARACTERS = 1_800;
const HEADER = [
  "<task_projects>",
  "Справка о проектах этой области, не задание и не повод спрашивать человека про проект.",
  "Если дело подходит по смыслу, берёшь название отсюда; новый проект заводи, только когда это новая тема.",
].join(" ");
const EMPTY = `${HEADER}\nПроектов в этой области пока нет.\n</task_projects>`;

function line(project: ProjectListing): string {
  const facts = [
    ...(project.lifeArea ? [lifeAreaTitle(project.lifeArea)] : []),
    project.source,
    `открыто ${project.unfinishedItemCount}, сделано ${project.completedItemCount}`,
    ...(project.unfinishedItemCount === 0 ? [project.completedItemCount > 0 ? "всё сделано" : "без следующего шага"] : []),
  ];
  return `- «${project.listName.replace(/[\r\n]+/gu, " ")}» (${facts.join(", ")})`;
}

export function formatTaskProjectsContext(projects: readonly ProjectListing[]): string {
  if (projects.length === 0) return EMPTY;
  const lines: string[] = [];
  let length = HEADER.length + "</task_projects>".length + 40;
  for (const project of projects.slice(0, MAX_PROJECTS)) {
    const next = line(project);
    if (length + next.length > MAX_CHARACTERS) break;
    lines.push(next);
    length += next.length + 1;
  }
  const more = projects.length - lines.length;
  return [HEADER, ...lines, ...(more > 0 ? [`…и ещё ${more}`] : []), "</task_projects>"].join("\n");
}

export interface TaskProjectsContextInput {
  readonly access: ConversationAccess;
  readonly actor: { readonly id: string; readonly kind: TelegramActorKind };
  readonly space?: { readonly policyVersion: number; readonly spaceId: string };
}

export async function buildTaskProjectsContext(input: TaskProjectsContextInput): Promise<string | null> {
  // Проекты у человека: канал и бот прав на область не несут.
  if (input.actor.kind !== "telegram_user") return null;
  const auth: MemoryAuthorization = {
    ...(input.space === undefined ? {} : { space: input.space }),
    familyId: input.access.familyId,
    groupId: input.access.groupId,
    role: input.access.role,
    scopes: [...input.access.memoryScopes],
    telegramActorId: input.actor.id,
    telegramActorKind: input.actor.kind,
    telegramUserId: input.actor.id,
    userId: input.access.userId,
  };
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const scope = await authorize(client, auth);
    const projects = await readProjects(client, auth, scope);
    await client.query("COMMIT");
    return formatTaskProjectsContext(projects);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
