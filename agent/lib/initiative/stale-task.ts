/**
 * Сообщение о деле, которое давно не двигалось: текст и кнопки, без модели.
 *
 * Экспорт:
 * - `StaleTask`: дело, о котором пишем, и день его последнего изменения.
 * - `formatStaleTask`: текст сообщения.
 * - `staleTaskButtons`: кнопки под ним, «Помоги начать» только когда модель семьи доступна.
 *
 * Владелец 21 октября 2026: обзор не должен констатировать просрочку, с зависшим делом надо бережно
 * помочь. Поэтому одно сообщение вместо ежедневного повтора, без счёта показов и оценок («Не стыдим
 * за просрочку», стайлгайд §7), и решение в одно касание. Текст собирает код: он приходит и тогда,
 * когда лимит расходов семьи исчерпан (решение 20 октября), пропадает только «Помоги начать».
 */
import type { TaskButtonItem } from "../task-buttons/task-button-repository.js";

export interface StaleTask {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  /** День последнего изменения в поясе человека, YYYY-MM-DD. */
  readonly since: string;
}

const TITLE_MAX = 120;

export function formatStaleTask(task: StaleTask): string {
  const flat = task.title.replace(/\s+/gu, " ").trim();
  const title = flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
  const since = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(`${task.since}T12:00:00Z`));
  return `«${title}» не менялось с ${since}. Что с ним сделаем?`;
}

/** Порядок и подписи по макету v3; подписи кнопок задаёт `staleTaskKeyboard`. */
export function staleTaskButtons(task: StaleTask, modelAvailable: boolean): TaskButtonItem[] {
  const ref = { id: task.id, version: task.version };
  return [
    ...(modelAvailable ? [{ action: "help_start" as const, task: ref }] : []),
    { action: "postpone_week", task: ref },
    { action: "cancel", task: ref },
    { action: "keep", task: ref },
  ];
}

export const STALE_TASK_LABELS = {
  cancel: "Снять",
  help_start: "Помоги начать",
  keep: "Оставить",
  postpone_week: "Через неделю",
} as const;
