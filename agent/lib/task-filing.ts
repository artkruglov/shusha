/**
 * Строка «куда записано»: место записи называет код, а не модель.
 *
 * Экспорт:
 * - `FiledTask`: то, что нужно знать о записи, чтобы назвать её место.
 * - `describeFiling`: готовый текст для человека.
 *
 * Прод 29 сентября 2026: из 56 открытых дел 21 лежали без списка, и человек не знал, куда бот
 * «накинул» сказанное. Промпт велел «одной фразой сказать, что записано», но место записи в ответ
 * не входило, и модель вправе была о нём промолчать. Теперь место (список или «пока без списка»,
 * срок, кто исполнитель, кто видит) собирает код, а модель пересылает строку как есть.
 *
 * Ждёт ли запись разбора, знает доска (раздел «Разобрать»): здесь только место записи. Счётчик разбора
 * в ответ инструмента не входит: модель читала его как команду спросить.
 */
import { lifeAreaTitle, type LifeArea } from "./life-areas.js";
import { cleanTaskTitle, dueDay, shortDate, type BoardTask } from "./task-board.js";

export interface FiledTask {
  readonly assignee?: string | null;
  readonly dueAt?: string | null;
  readonly dueOn?: string | null;
  readonly kind: string;
  readonly lifeArea?: LifeArea | null;
  readonly listName?: string | null;
  readonly scope?: string;
  readonly status: string;
  readonly title: string;
}

/** Пакет из двадцати записей одним сообщением это стена текста: остальное считается числом. */
const FILING_MAX_LINES = 6;

const AUDIENCE: Record<string, string> = {
  family: "видит вся семья", group: "видит группа", personal: "видишь только ты",
};

function placeOf(task: FiledTask): string[] {
  if (task.kind === "idea") return [task.listName ? `идея, список «${task.listName}»` : "идея, «Когда-нибудь»"];
  if (task.kind === "ritual") return ["традиция"];
  const where = [...(task.lifeArea ? [lifeAreaTitle(task.lifeArea)] : []),
    ...(task.listName ? [`список «${task.listName}»`] : [])];
  return where.length === 0 ? ["пока без списка"] : [where.join(", ")];
}

function whoOf(task: FiledTask): string[] {
  if (task.kind !== "task" || task.scope === "personal") return [];
  // Запись без исполнителя или без согласия ничего не обещает: строка называет это одним словом, а
  // что делать дальше, одной общей строкой под списком (`describeFiling`), иначе пакет из семи ничьих
  // дел повторял бы одну фразу семь раз. Имя не склоняется: ошибка окончания режет глаз.
  if (task.status === "open") return ["ничьё"];
  if (task.status === "proposed") return [task.assignee ? `ждёт согласия: ${task.assignee}` : "ждёт согласия"];
  return task.assignee ? [`исполнитель ${task.assignee}`] : [];
}

export function describeFiling(tasks: readonly FiledTask[], timezone: string): { filed: string } {
  const lines = tasks.map((task) => {
    const due = dueDay({ dueAt: task.dueAt ?? null, dueOn: task.dueOn ?? null } as BoardTask, timezone);
    const when = task.kind === "task" ? [due ? `срок ${shortDate(due)}` : "без срока"] : [];
    const parts = [...placeOf(task), ...when, ...whoOf(task), AUDIENCE[task.scope ?? "personal"] ?? AUDIENCE.personal!];
    return `• «${cleanTaskTitle(task.title, "plain")}» → ${parts.join(", ")}`;
  });
  const shown = lines.slice(0, FILING_MAX_LINES);
  const more = lines.length - shown.length;
  // «Записано» не должно читаться как «делается»: что никто не взял и что ещё не принято, говорится
  // прямо и один раз, понятно обеим сторонам (прод 1 октября 2026: 19 ничьих дел висели молча).
  const commitments = tasks.filter((task) => task.kind === "task" && task.scope !== "personal");
  const unowned = commitments.some((task) => task.status === "open");
  const waiting = [...new Set(commitments.filter((task) => task.status === "proposed").map((task) => task.assignee ?? ""))]
    .filter((name) => name !== "");
  const caveats = [
    ...(unowned ? ["Ничьи дела никто не взял: скажи «беру» или назови, кому."] : []),
    ...(commitments.some((task) => task.status === "proposed")
      ? [`Ждут согласия${waiting.length > 0 ? `: ${waiting.join(", ")}` : ""}. Пока ответа нет, дело не назначено.`] : []),
  ];
  return { filed: [...shown, ...(more > 0 ? [`…и ещё ${more}`] : []), ...caveats].join("\n") };
}

/**
 * Закрытие ничьего дела записывает его на закрывшего. Человек, говоря «я сделал», этого не просил,
 * поэтому ответ называет такие дела прямо; `null`, когда таких нет. Без глаголов с родом и без «ты»:
 * в группе читают двое, а бот пишет о себе в женском роде.
 */
export function describeAdoptedClosures(adopted: readonly { readonly title: string; readonly assignee?: string | null }[]): string | null {
  if (adopted.length === 0) return null;
  const shown = adopted.slice(0, FILING_MAX_LINES).map((item) => `«${cleanTaskTitle(item.title, "plain")}»`);
  const more = adopted.length - shown.length;
  const who = adopted.find((item) => item.assignee)?.assignee;
  const lead = adopted.length === 1 ? "Было ничьё, никто не брал" : "Были ничьими, никто не брал";
  const closed = adopted.length === 1 ? "Закрыто" : "Закрыты";
  return `${lead}: ${shown.join(", ")}${more > 0 ? `, …и ещё ${more}` : ""}. ${closed}${who ? `, исполнитель: ${who}` : ""}.`;
}
