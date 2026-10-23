/**
 * Доска дел в чате, v3 (`docs/design/task-lists-v3.ru.md`): главное сверху, проекты свёрнуты.
 *
 * Exports:
 * - `formatRichTaskBoard`: Rich Markdown доски «покажи дела» или `null`, когда показывать нечего.
 * - `taskBoardReply`, `BoardButtons`: та же доска для отдельного сообщения, с кнопками в тексте.
 *
 * 21 октября 2026 владелец назвал доску неинформативной: 57 дел шли разделами подряд, и сегодняшнее
 * тонуло среди работы и дома. Здесь сначала то, что делать сегодня, затем просроченное и одна строка
 * о давних делах, а каждый проект свёрнут в `<details>` со счётом и следующим шагом. Разделы те же,
 * что у Mini App и утреннего обзора (`taskBoardSections`), меняется только вёрстка. Одноимённые
 * проекты разных областей («Мы вдвоём» личный и семейный) на доске одного человека сливаются в один
 * раздел, а строки говорят словами, чьи они: данные и права при этом не меняются.
 *
 * Маркеры по стайлгайду (§3.2): только ⚠️ перед «Просрочено». Своих цветов нет. Кнопки (Bot API 10.3,
 * `<tg-button-row>`) стоят прямо в тексте: «✓ дело» под сегодняшним и просроченным, «Разобрать» у давних, а
 * закрытое кнопкой этой доски остаётся наверху зачёркнутым с «↩ Вернуть» (`task-buttons/board-buttons.ts`).
 * Проверено 21 октября на живом клиенте: нажатие внутри свёрнутого проекта тоже доходит. `<tg-time>` не берём:
 * клиент пишет дату на своём языке, по-английски посреди русского текста.
 */
import {
  cleanTaskTitle, isStale, localDate, taskBoardSections, type BoardProject, type BoardRow, type BoardSection, type BoardTask,
  type TaskBoardInput,
} from "./task-board.js";
import { taskButtonLabel } from "./task-buttons/task-button-keyboard.js";

/** Потолок доски в чате: свёрнутые проекты коротки на экране, но сообщение не должно расти без конца. */
export const RICH_TASK_BOARD_MAX_CHARACTERS = 12_000;
const PERSONAL_SOURCE = "Личное";
const PROJECT_ROWS = 5;
/** Разделы до проектов, в этом порядке; «Сегодня» первым (решение владельца 21 октября 2026). */
const TOP: readonly BoardSection["kind"][] = ["today", "overdue"];
const MIDDLE: readonly BoardSection["kind"][] = ["unowned", "unaccepted", "unsorted"];
const BOTTOM: readonly BoardSection["kind"][] = ["stalled", "finished", "waiting"];
// Без «Скажи…» (ревью 21 октября 2026): что сделать, говорят кнопки, а без кнопок (в группе) хватает факта.
const STALE_HINT = "Не менялись больше двух недель.";

/** Кнопки доски: «✓» и «Беру» по id дела, «Завершить» по id проекта, адреса Mini App, закрытое этой доской. */
export interface BoardButtons {
  readonly complete: ReadonlyMap<string, string>;
  readonly claim?: ReadonlyMap<string, string>;
  readonly finish?: ReadonlyMap<string, string>;
  readonly review?: string;
  /** «Открыть доску» в конце: вся доска в Mini App. */
  readonly open?: string;
  readonly closed?: readonly { readonly title: string; readonly undo: string | null }[];
}

export function formatRichTaskBoard(
  input: Omit<TaskBoardInput, "style"> & { buttons?: BoardButtons; heading?: string },
): string | null {
  const { commitments, sections } = taskBoardSections({ ...input, style: "rich" });
  // A board whose last task was just closed by its own «✓» still shows that, with its undo.
  if (sections.length === 0 && (input.buttons?.closed?.length ?? 0) === 0) return null;
  const today = localDate(input.timezone, input.now);
  const stale = input.tasks.filter((task) => isStale(task, today)).length;
  const of = (kind: BoardSection["kind"]) => sections.filter((section) => section.kind === kind);
  const todayCount = of("today").reduce((sum, section) => sum + section.rows.length, 0);

  // Счётчики как в сводке (стайлгайд §3.3): «Никто не взял · 3 · Просят тебя · 1», без согласования числа.
  const summary = [`Открытых · ${commitments}`, ...(todayCount > 0 ? [`Сегодня · ${todayCount}`] : []),
    ...(stale > 0 ? [`Давно без движения · ${stale}`] : [])].join(" · ");
  const head = [`### ${input.heading ?? "Твои дела"}`, summary].join("\n\n");
  const buttons = input.buttons;
  const closed = buttons?.closed && buttons.closed.length > 0 ? [closedBlock(buttons.closed)] : [];
  const top = TOP.flatMap(of).map((section) => flatBlock(section, buttons));
  const review = buttons?.review
    ? [`<tg-button-row><tg-button type="web_app" url="${attribute(buttons.review)}">Разобрать</tg-button></tg-button-row>`] : [];
  const staleBlock = stale > 0 ? [[`**Давно без движения · ${stale}**`, "", STALE_HINT, ...review].join("\n")] : [];
  const middle = MIDDLE.flatMap(of).map((section) => flatBlock(section, buttons));
  const projects = mergedProjects(of("project")).map(projectBlock);
  const bottom = BOTTOM.flatMap(of).map((section) => flatBlock(section, buttons));
  // Идеи и традиции обычно одна строка счёта; когда кроме них ничего нет («покажи идеи»), их названия и есть доска.
  const onlySomeday = sections.every((section) => section.kind === "ideas" || section.kind === "rituals");
  const someday = onlySomeday ? [] : [...of("ideas"), ...of("rituals")].map((section) => `${section.title} · ${section.rows.length}`);
  const somedayBlocks = onlySomeday ? [...of("ideas"), ...of("rituals")].map((section) => flatBlock(section)) : [];
  const open = buttons?.open
    ? [`<tg-button-row><tg-button type="web_app" url="${attribute(buttons.open)}">Открыть доску</tg-button></tg-button-row>`] : [];
  const tail = [...somedayBlocks, ...(someday.length > 0 ? [someday.join(" · ")] : []), ...open];

  // Свёрнутые проекты уходят с конца целиком, не рвутся посередине; хвост называет каждый.
  const fixed = [head, ...closed, ...top, ...staleBlock, ...middle];
  const after = [...bottom, ...tail];
  const size = (blocks: readonly string[]) => blocks.reduce((sum, block) => sum + block.length + 2, 0);
  let kept = projects.length;
  const dropped = () => projects.slice(kept).map((block) => block.name);
  const total = () => size(fixed) + size(projects.slice(0, kept).map((block) => block.text)) + size(after)
    + (kept < projects.length ? droppedLine(dropped()).length + 2 : 0);
  while (kept > 0 && total() > RICH_TASK_BOARD_MAX_CHARACTERS) kept -= 1;
  return [...fixed, ...projects.slice(0, kept).map((block) => block.text),
    ...(kept < projects.length ? [droppedLine(dropped())] : []), ...after].join("\n\n");
}

/** Доску отдельным сообщением шлёт канал (`telegram-turn-board.ts`), модель её не видит. */
export function taskBoardReply(
  tasks: readonly BoardTask[], now: Date, timezone: string, projects?: readonly BoardProject[], buttons?: BoardButtons,
): string | null {
  return formatRichTaskBoard({ now, tasks, timezone, ...(projects ? { projects } : {}), ...(buttons ? { buttons } : {}) });
}

/**
 * Подсказок «Скажи…» доска не пишет (ревью 21 октября 2026): у сегодняшнего и просроченного «✓», у ничьего
 * «Беру», у проекта, где всё сделано, «Завершить». Без кнопок (в группе) раздел остаётся просто списком.
 */
function flatBlock(section: BoardSection, buttons?: BoardButtons): string {
  const rows = section.rows.slice(0, section.limit);
  const shown = rows.map((row) => `- ${line(row)}`);
  const more = section.rows.length - shown.length;
  const done = section.progress ? ` · сделано ${section.progress.completed} из ${section.progress.total}` : "";
  const taskId = (row: BoardRow) => String((row.task as { id?: unknown } | null)?.id ?? "");
  const taps = rows.flatMap((row) => {
    const complete = buttons?.complete.get(taskId(row));
    if (complete) return [callbackButton(complete, taskButtonLabel("✓", row.title))];
    const claim = buttons?.claim?.get(taskId(row));
    if (claim) return [callbackButton(claim, taskButtonLabel("Беру ·", row.title))];
    const finish = row.project ? buttons?.finish?.get(row.project.id) : undefined;
    return finish ? [callbackButton(finish, taskButtonLabel("Завершить ·", row.title))] : [];
  });
  // Хвост это отдельный абзац: без пустой строки разметка печатает его внутри пункта.
  return [`**${section.title} · ${section.rows.length}${done}**`, "", ...shown, ...buttonRows(taps),
    ...(more > 0 ? ["", `…и ещё ${more}`] : [])].join("\n");
}

/** Закрытое кнопкой этой доски: на месте, зачёркнутым, с возвратом (стайлгайд §3.4–3.5). */
function closedBlock(closed: NonNullable<BoardButtons["closed"]>): string {
  const lines = closed.map((item) => `- ✓ ~~${cleanTaskTitle(item.title, "rich")}~~`);
  const undo = closed.flatMap((item) => item.undo ? [callbackButton(item.undo, taskButtonLabel("↩", `Вернуть · ${item.title}`))] : []);
  return [`**Только что закрыто · ${closed.length}**`, "", ...lines, ...buttonRows(undo)].join("\n");
}

/** Два в ряд (стайлгайд §3.11); строка кнопок идёт отдельным блоком после списка. */
function buttonRows(buttons: readonly string[]): string[] {
  const rows: string[] = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(`<tg-button-row>${buttons.slice(index, index + 2).join("")}</tg-button-row>`);
  }
  return rows.length > 0 ? ["", ...rows] : [];
}

function callbackButton(data: string, label: string): string {
  return `<tg-button type="callback_data" data="${attribute(data)}">${attribute(label)}</tg-button>`;
}

/** Текст и атрибут HTML-тега: название дела пишет человек, и `<`, `&`, `"` в нём не должны стать разметкой. */
function attribute(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function line(row: BoardRow, tag = ""): string {
  return `${cleanTaskTitle(row.title, "rich")}${row.suffix}${tag}`;
}

interface MergedProject {
  readonly name: string;
  readonly progress?: { readonly completed: number; readonly total: number };
  readonly rows: readonly { readonly row: BoardRow; readonly tag: string }[];
}

/**
 * Одноимённые проекты и списки разных областей становятся одним разделом. У строк слитого раздела
 * подпись видимости: «только мне» у личного, имя области у остального (принцип 4 стайлгайда).
 */
function mergedProjects(sections: readonly BoardSection[]): MergedProject[] {
  const byName = new Map<string, BoardSection[]>();
  for (const section of sections) {
    const name = section.group ?? section.title;
    byName.set(name, [...(byName.get(name) ?? []), section]);
  }
  return [...byName.entries()].map(([name, parts]) => {
    const sources = new Set(parts.flatMap((part) => part.rows.map((row) => row.task?.source ?? PERSONAL_SOURCE)));
    const mixed = sources.size > 1;
    const rows = parts.flatMap((part) => part.rows.map((row) => {
      const source = row.task?.source ?? PERSONAL_SOURCE;
      const tag = mixed ? (source === PERSONAL_SOURCE ? " · только мне" : ` · ${cleanTaskTitle(source, "rich").toLowerCase()}`) : "";
      return { row, tag };
    }));
    // Прогресс говорит о проекте, а не о сумме разных: у слитого раздела его нет.
    const progress = parts.length === 1 ? parts[0]!.progress : undefined;
    return { name, rows, ...(progress ? { progress } : {}) };
  });
}

/**
 * Проект свёрнут: в строке счёт и следующий шаг, раскрытие показывает до пяти дел. Внутри `<details>`
 * нет пустых строк: так блок записан в документации Bot API, а пустая строка в HTML-блоке Markdown
 * его закрывает.
 */
function projectBlock(project: MergedProject): { name: string; text: string } {
  const name = cleanTaskTitle(project.name, "rich");
  const done = project.progress ? ` · сделано ${project.progress.completed} из ${project.progress.total}` : "";
  const next = project.rows[0] ? ` · дальше: ${cleanTaskTitle(project.rows[0].row.title, "rich")}` : "";
  const shown = project.rows.slice(0, PROJECT_ROWS).map(({ row, tag }) => `- ${line(row, tag)}`);
  const more = project.rows.length - shown.length;
  return {
    name: `${project.name} · ${project.rows.length}`,
    text: [`<details><summary>**${name} · ${project.rows.length}**${done}${next}</summary>`, ...shown,
      ...(more > 0 ? [`- …и ещё ${more}`] : []), "</details>"].join("\n"),
  };
}

const DROPPED_NAMES_MAX = 8;

function droppedLine(names: readonly string[]): string {
  const shown = names.slice(0, DROPPED_NAMES_MAX).map((name) => cleanTaskTitle(name, "rich"));
  const more = names.length - shown.length;
  return `Не поместились: ${shown.join("; ")}${more > 0 ? ` и ещё ${more}` : ""}. Спроси о любом отдельно.`;
}
