/**
 * Root-owned task lifecycle. The repository derives identity and scope from verified auth.
 *
 * Описание уходит в промпт каждого чата, где инструмент выдан, включая внешнюю группу по гранту,
 * поэтому здесь остаётся только протокол вызова. Раздел про дела, желания и традиции написан для
 * доверенных чатов и живёт в их блоке режима.
 */
import { defineTool } from "eve/tools";
import { currentTimeRepository } from "../current-time-repository.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { CLOSED_TASK_STATUSES, sharedTaskInput } from "../shared-tasks.js";
import { sharedTaskRepository } from "../shared-task-repository.js";
import { loadBoardProjects } from "../projects/project-board.js";
import { closedTaskBoard, type BoardTask } from "../task-board.js";
import { boardMarkdown } from "../task-buttons/board-buttons.js";
import { markTelegramKeepOpen } from "../telegram-keep-open-turns.js";
import { markTurnBoard, type TurnBoard } from "../telegram-turn-board.js";
import { progressNoticeKey } from "../telegram-progress-deferral.js";
import { describeAdoptedClosures, describeFiling, type FiledTask } from "../task-filing.js";

/** Записи, о месте которых нужно сказать: созданные и уточнённые, кроме повтора прежнего вызова. */
const FILING_ACTIONS = new Set(["create", "clarify"]);

function filingSubjects(input: { action?: unknown; items?: unknown }, result: unknown): FiledTask[] | null {
  const outcome = result as { replayed?: boolean; task?: FiledTask; tasks?: FiledTask[] };
  if (outcome.replayed) return null;
  if (typeof input.action === "string" && FILING_ACTIONS.has(input.action)) return outcome.task ? [outcome.task] : null;
  if (input.action !== "batch" || !Array.isArray(input.items) || !outcome.tasks) return null;
  // Ответ пакета идёт в порядке пунктов: закрытия и правки в рассказ о месте записи не входят.
  const subjects = outcome.tasks.filter((_, index) => FILING_ACTIONS.has(String((input.items as { action?: unknown }[])[index]?.action)));
  return subjects.length > 0 ? subjects : null;
}

export default defineTool({
  description: [
    "Планировщик дел, идей и традиций.",
    "Одно действие над несколькими делами это один batch, а не вызов на каждое: items до 20, в пункте action и поля этого действия, одно дело в пакете один раз. В пакет идёт всё, кроме чтений, передачи и release. Отказ пункта отменяет весь пакет, причина в ответе.",
    "create: title, kind task|idea|ritual (по умолчанию task), listName, details; срок dueAt или dueOn только у task. Идея и традиция не обязательство участников.",
    "create без assigneeRef пишет дело на автора принятым; unassigned:true заводит ничьё дело open, только в группе. claim берёт ничьё, занятое взять нельзя.",
    "reopen: id закрытого по ошибке (из ответа закрытия или view done) возвращает его в работу.",
    "Область выводится из чата, личное не публикуй в группе. В личке list показывает мои назначения и запланированные мной идеи/традиции, в группе только её область.",
    "list без status: только незакрытое, view done: закрытые; строки краткие, полная запись с details: get с id. show:true на просьбу показать дела: доску приложит сервер, сам список не пиши.",
    "Фильтры list: status, listName, view mine|promised|waiting|open|today|ideas|rituals|planned|inbox|transfers|done. promised: что поручили мне другие; waiting: мои просьбы другим; open: свободные; today: срок или план на сегодня в поясе человека, просроченное первым; inbox: неразобранное без срока и плана (в группе без личного плана). planned и from/until YYYY-MM-DD только в личке. nextCursor передай как cursor; hidden: сколько дел групп скрыто проверкой доступа, скажи это. lists: имена списков с источником, одно имя в разных чатах это разные списки. lifeArea self|couple|kids|home|work и одноимённые view: сфера жизни.",
    "plan: id, plannedFrom, plannedUntil YYYY-MM-DD; личный период, не общий срок. unplan: id.",
    "update или clarify: id, version из list и изменения title/details/listName/dueAt/dueOn, null очищает поле. clarify по явной просьбе убирает из inbox, сохраняя originalText. Свободное правят читатели, принятое исполнитель. activate с id/version делает идею своим делом только по просьбе.",
    "careAreaRef связывает create с доступной областью заботы и сужает list до её дел.",
    "transfer: id, version, assigneeRef; до согласия отвечаю я, получатель в pendingAssignee. accept_transfer/decline_transfer отвечают, view transfers показывает входящие. release с id/version освобождает моё дело.",
    "Поручить другому: participants, затем create с assigneeRef; получатель сам принимает или отклоняет proposed, чужое согласие не выдумывай. complete закрывает принятое тобой или ничьё (станет твоим, notice в ответе); чужое только исполнитель; cancel автору и исполнителю.",
    "record: id традиции, occurredOn, note только о явно сообщённом опыте; history. Пропуск традиции не долг.",
    "Срок не создаёт уведомление. По просьбе в личке manage_reminder create с taskId и content равным title напоминает о моём принятом деле/традиции или проверяет ответ на мою просьбу proposed; завершение и отмена гасят сигналы. Если инструмента нет, скажи об этом.",
  ].join(" "),
  inputSchema: sharedTaskInput,
  async execute(input, ctx) {
    const auth = requireMemoryAuthorization(ctx);
    const operationKey = `${ctx.session.id}:${ctx.callId}`;
    const result = await sharedTaskRepository.execute(auth, input, operationKey);
    // Служебное поле не для модели: человеку о нём говорит готовая строка `notice`.
    const { adopted: adoptedItems, ...visible } = result as typeof result & { adopted?: { title: string; assignee: string | null }[] };
    const adopted = describeAdoptedClosures(adoptedItems ?? []);
    // Итог записи или закрытия человек должен видеть, а не искать под «Полный ответ»: ход помечается,
    // и канал сам добавит к ответу директиву (`telegram-keep-open-turns.ts`). В тексте ответа
    // инструмента её нет: модель пересказывала такие строки или оборачивала их парой тегов.
    const turn = (ctx as { session?: { id?: string; turn?: { id?: string } } }).session;
    const keepOpen = () => {
      if (typeof turn?.id === "string" && typeof turn.turn?.id === "string") markTelegramKeepOpen(progressNoticeKey(turn.id, turn.turn.id));
    };
    const notice = adopted === null ? {} : { notice: adopted };
    const filedTasks = filingSubjects(input, visible);
    if (filedTasks !== null) {
      const timezone = await currentTimeRepository.findTurnTimezone(auth.userId, auth.familyId) ?? "UTC";
      // Ни счётчика разбора, ни списка существующих списков наружу не отдаётся: в эвале 29 сентября
      // модель читала любое из них как команду «спроси, куда положить» и допрашивала на «купить
      // батарейки». Спрашивать ли, решает сама запись (расплывчатая или нет), а не подсказка в ответе.
      keepOpen();
      return { ...visible, ...notice, filed: describeFiling(filedTasks, timezone).filed };
    }
    if (adopted !== null) {
      keepOpen();
      return { ...visible, ...notice };
    }
    // Доску собирает код и прикладывает канал: 21 октября модель пересказала поле `board` сплошными
    // строками по девять дел. Теперь модель доски не видит, а просит её флагом `show`; без него `list`
    // это чтение для работы (например, перед закрытием), и доска под ответом была бы лишней.
    // Виды чужих обязательств (просьбы другим, входящие передачи) доской не оформляются: там
    // строки не про дела самого человека, и «Открытых дел: N» вводило бы в заблуждение.
    const ownList = input.action === "list" && input.show === true && !["transfers", "waiting"].includes(String(input.view ?? ""));
    const tasks = ownList ? (visible as { tasks?: readonly BoardTask[] }).tasks : undefined;
    if (!tasks) return visible;
    const board = await turnBoard(input, tasks, auth);
    if (board === null) return { ...visible, board: "Показывать нечего: открытых дел нет." };
    // Without a turn to attach it to, nothing would show the board: then the model answers with the list itself.
    if (typeof turn?.id !== "string" || typeof turn.turn?.id !== "string") return visible;
    markTurnBoard(progressNoticeKey(turn.id, turn.turn.id), board);
    return { ...visible, board: "Человек получит доску отдельным сообщением после ответа. О доске не говори и дела не перечисляй: одна фраза о главном или ничего." };
  },
});

/** Доска хода: Rich Markdown с кнопками «✓» в личке; канал шлёт её отдельным сообщением после ответа. */
async function turnBoard(
  input: { careAreaRef?: string; lifeArea?: string | null; listName?: string | null; status?: string; view?: string },
  tasks: readonly BoardTask[],
  auth: ReturnType<typeof requireMemoryAuthorization>,
): Promise<TurnBoard | null> {
  // Закрытое показывает своя доска: открытая отбросила бы все его строки.
  if (input.view === "done" || (input.status && CLOSED_TASK_STATUSES.includes(input.status as never))) {
    const markdown = closedTaskBoard(tasks, "rich");
    return markdown === null ? null : { markdown };
  }
  const timezone = await currentTimeRepository.findTurnTimezone(auth.userId, auth.familyId) ?? "UTC";
  const projects = await loadBoardProjects(auth);
  // The board keeps the list it was asked for: a press redraws «на сегодня», not the whole list (ревью 21 октября 2026).
  const filters = Object.fromEntries((["careAreaRef", "lifeArea", "listName", "status", "view"] as const)
    .flatMap((key) => typeof input[key] === "string" ? [[key, input[key] as string]] : []));
  const markdown = await boardMarkdown({ auth, now: new Date(), query: { filters, source: "list" }, tasks, timezone, ...(projects ? { projects } : {}) });
  return markdown === null ? null : { markdown };
}
