/**
 * Карточка дела в Mini App: поля дела, его история и действия, которые к нему подходят.
 *
 * Exports:
 * - `WebAppTaskCard`, `WebAppHistoryEntry`, `WebAppCardAction`: то, что получает страница.
 * - `TaskVersionRow`, `TaskCardFacts`: сырьё из базы.
 * - `historyEntries`: журнал версий словами («Артём · перенос: 13 → 14 октября»).
 * - `longDay`: дата словами, как на макетах: «14 октября».
 * - `webAppTaskCard`: карточка из дела, прочитанного репозиторием, и фактов о нём.
 *
 * Дело читает `sharedTaskRepository` (`get`) с правами лички, как в чате: карточку чужого дела страница
 * не получит. История берётся из `shared_task_versions`: каждая строка хранит запись до изменения, поэтому
 * «стало» это запись следующей версии, а для последней сама текущая. Глагола с родом нет («Артём · сделано»):
 * пол человека мы не знаем и не угадываем по имени.
 */
import { localDate } from "../task-board.js";

export type WebAppCardAction = "accept" | "accept_transfer" | "cancel" | "claim" | "complete" | "decline" | "decline_transfer"
  | "postpone" | "release" | "reopen" | "share" | "transfer" | "unshare";

export interface WebAppHistoryEntry {
  readonly at: string;
  readonly text: string;
}

export interface WebAppTaskCard {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly details: string | null;
  readonly status: string;
  readonly kind: string;
  readonly project: string | null;
  readonly dueOn: string | null;
  readonly dueAt: string | null;
  /** На сколько дней просрочено по дню человека; 0, если не просрочено или срока нет. */
  readonly overdueDays: number;
  readonly assignee: string | null;
  readonly visibility: string;
  readonly repeat: boolean;
  /** Who the task waits for, in words: «Ждёт ответа: Юля», «Просит: Юля», «Юля передаёт вам». */
  readonly waiting: string | null;
  readonly actions: readonly WebAppCardAction[];
  readonly history: readonly WebAppHistoryEntry[];
  /** День человека, от которого считаются «Сегодня / Завтра / Выходные» переноса. */
  readonly today: string;
}

/** Строка `shared_task_versions` с записью до изменения. */
export interface TaskVersionRow {
  readonly action: string;
  readonly actorTelegramId: string;
  readonly at: Date;
  readonly before: { readonly due_on?: string | null; readonly title?: string; readonly assignee_telegram_id?: string | null };
}

/** То, чего нет в ответе репозитория: автор, когда создано, кто исполнитель по id и чья область. */
export interface TaskCardFacts {
  readonly assigneeTelegramId: string | null;
  readonly createdAt: Date;
  readonly creatorTelegramId: string;
  /** No area written (`space_id` NULL): an idea or a tradition changes who sees it in place. */
  readonly inPlace: boolean;
  readonly names: ReadonlyMap<string, string>;
  /** Whom the assignee offered the task to (`shared-task-handover.ts`); until they agree it stays the assignee's. */
  readonly pendingAssigneeTelegramId: string | null;
  /** Someone besides the author planned the idea or marked the tradition: it stays shared. */
  readonly pickedUpByOthers: boolean;
  readonly space: string | null;
  readonly viewerTelegramId: string;
}

/** Что прочитал `get` (`present` в `shared-task-access.ts`). */
export interface PresentedTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly kind: string;
  readonly dueAt: string | null;
  readonly dueOn: string | null;
  readonly listName: string | null;
  readonly details: string | null;
  readonly scope: string;
  readonly version: number;
  readonly repeat: unknown;
}

const LABELS: Readonly<Record<string, string>> = {
  accept: "принято", accept_transfer: "передача принята", activate: "в работе", cancel: "снято",
  claim: "взято", clarify: "уточнено", complete: "сделано", decline: "отказ", decline_transfer: "передача отклонена",
  plan: "запланировано", record: "отмечено", release: "отпущено", reopen: "возвращено", transfer: "передача",
  unplan: "план снят",
};

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября",
  "ноября", "декабря"] as const;

export function longDay(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]}`;
}

function dayLabel(day: string | null | undefined): string {
  return day ? longDay(day) : "без срока";
}

function at(date: Date, timezone: string): string {
  const time = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(date);
  return `${longDay(localDate(timezone, date))} · ${time}`;
}

export function historyEntries(
  rows: readonly TaskVersionRow[],
  current: { readonly dueOn: string | null; readonly title: string },
  facts: Pick<TaskCardFacts, "createdAt" | "creatorTelegramId" | "names">,
  timezone: string,
): WebAppHistoryEntry[] {
  const name = (telegramId: string) => facts.names.get(telegramId) ?? "Участник";
  const entries: WebAppHistoryEntry[] = [
    { at: at(facts.createdAt, timezone), text: `${name(facts.creatorTelegramId)} · создано` },
  ];
  rows.forEach((row, index) => {
    const after = rows[index + 1]?.before ?? { due_on: current.dueOn, title: current.title };
    let label = LABELS[row.action] ?? "изменено";
    if (row.action === "update") {
      const parts: string[] = [];
      if ((row.before.due_on ?? null) !== (after.due_on ?? null)) {
        parts.push(`перенос: ${dayLabel(row.before.due_on)} → ${dayLabel(after.due_on)}`);
      }
      if (row.before.title !== undefined && after.title !== undefined && row.before.title !== after.title) {
        parts.push("новое название");
      }
      if (parts.length > 0) label = parts.join(", ");
    }
    entries.push({ at: at(row.at, timezone), text: `${name(row.actorTelegramId)} · ${label}` });
  });
  return entries;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Кнопки карточки по правилам `applyTaskStatus`: снять своё принятое или предложенное может автор или
 * исполнитель, ничьё только автор; вернуть закрытое может тот, кто его вёл или завёл. Это только какие кнопки
 * рисовать: при нажатии решает репозиторий.
 */
function cardActions(task: PresentedTask, facts: TaskCardFacts, canMove: boolean): WebAppCardAction[] {
  const mine = facts.assigneeTelegramId === facts.viewerTelegramId;
  const author = facts.creatorTelegramId === facts.viewerTelegramId;
  if (task.kind !== "task") return ideaActions(task, facts, author && mine, author);
  const repeated = task.repeat !== null && task.repeat !== undefined;
  if (task.status === "completed" || task.status === "cancelled") {
    return (mine || author) && !repeated ? ["reopen"] : [];
  }
  if (task.status === "open") return author ? ["claim", "complete", "cancel"] : ["claim", "complete"];
  if (task.status === "proposed") {
    if (mine) return ["accept", "decline"];
    return author ? ["cancel"] : [];
  }
  // A handover in flight: the recipient answers it, the assignee may take the offer back (`applyTaskHandover`).
  const pending = task.status === "accepted" ? facts.pendingAssigneeTelegramId ?? null : null;
  if (pending !== null && pending === facts.viewerTelegramId) return ["accept_transfer", "decline_transfer"];
  if (task.status !== "accepted" || !(mine || author)) return [];
  const actions: WebAppCardAction[] = mine ? ["complete"] : [];
  // «Передать…» and «Сделать ничьим» for one's own family task. A personal one is made shared first, by its own
  // button: sharing and handing over are two operations, and a handover refused after a share would leave it shared.
  if (mine && pending === null && task.scope === "family") actions.push("transfer");
  if (mine && pending === null && task.scope === "family") actions.push("release");
  if (mine && pending !== null) actions.push("decline_transfer");
  if (canMove && task.dueAt === null && !repeated) actions.push("postpone");
  actions.push("cancel");
  // Who sees it (`shared-task-visibility.ts`): the author's own task goes shared or back; asked of another, it stays shared.
  if (author && mine && task.scope === "personal") actions.push("share");
  if (author && mine && task.scope === "family") actions.push("unshare");
  return actions;
}

/**
 * An idea or a tradition: «who sees it», by the rules of `shared-task-visibility.ts` (its author's, without a written
 * area, back to personal only while nobody else planned or marked it), and «Снять» by its author.
 */
function ideaActions(task: PresentedTask, facts: TaskCardFacts, authorKeeps: boolean, author: boolean): WebAppCardAction[] {
  if (!["open", "proposed", "accepted"].includes(task.status)) return [];
  const actions: WebAppCardAction[] = [];
  if (authorKeeps && facts.inPlace && task.scope === "personal") actions.push("share");
  if (authorKeeps && facts.inPlace && task.scope === "family" && !facts.pickedUpByOthers) actions.push("unshare");
  // «Снять» by its author, as in the chat (`applyTaskStatus` lets an idea or a tradition be cancelled and reopened).
  if (author) actions.push("cancel");
  return actions;
}

/** Who the open task waits for, said from the viewer's side. */
function waitingLine(task: PresentedTask, facts: TaskCardFacts): string | null {
  const name = (telegramId: string) => facts.names.get(telegramId) ?? "Участник";
  const viewer = facts.viewerTelegramId;
  if (task.status === "proposed" && facts.assigneeTelegramId !== null) {
    if (facts.assigneeTelegramId === viewer) return facts.creatorTelegramId === viewer ? null : `Просит: ${name(facts.creatorTelegramId)}`;
    return `Ждёт ответа: ${name(facts.assigneeTelegramId)}`;
  }
  const pending = task.status === "accepted" ? facts.pendingAssigneeTelegramId ?? null : null;
  if (pending === null || facts.assigneeTelegramId === null) return null;
  if (pending === viewer) return `${name(facts.assigneeTelegramId)} передаёт вам это дело`;
  return `Передаётся: ${name(pending)}, ждёт ответа`;
}

export function webAppTaskCard(
  task: PresentedTask,
  facts: TaskCardFacts,
  history: readonly TaskVersionRow[],
  options: { canMove: boolean; now: Date; timezone: string },
): WebAppTaskCard {
  const today = localDate(options.timezone, options.now);
  const due = task.dueOn ?? (task.dueAt ? localDate(options.timezone, new Date(task.dueAt)) : null);
  const open = task.status === "open" || task.status === "proposed" || task.status === "accepted";
  return {
    actions: cardActions(task, facts, options.canMove),
    assignee: facts.assigneeTelegramId ? facts.names.get(facts.assigneeTelegramId) ?? "Участник" : null,
    details: task.details,
    dueAt: task.dueAt,
    dueOn: task.dueOn,
    history: historyEntries(history, task, facts, options.timezone),
    id: task.id,
    kind: task.kind,
    overdueDays: open && due !== null && due < today ? daysBetween(due, today) : 0,
    project: task.listName,
    repeat: task.repeat !== null && task.repeat !== undefined,
    waiting: waitingLine(task, facts),
    status: task.status,
    title: task.title,
    today,
    version: task.version,
    visibility: task.scope === "personal" ? "Только мне" : facts.space ?? "Семья",
  };
}
