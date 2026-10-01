/** Does the model capture and close tasks the way the task contract asks? Paid live probe.
 * MODEL_API_KEY=… npx tsx stress/prompt-evals/task-requests.ts --out .tmp/evals/tasks-1 --max-requests 30 [--samples 2] [--reasoning-none] [--dry]
 * Refuses above --max-requests and sends requests one at a time to share the cached prefix.
 *
 * 19–21 September 2026, production: a list dictated in the family group never became tasks, and
 * "закрой этим задачи" in private turned into 18 reads of the registry without one complete. The
 * cases below are those real messages plus the two group stories of docs/task-user-stories.ru.md.
 * `manage_shared_tasks` is declared, not executed: every call gets a stub result, up to three steps.
 *
 * 29 September 2026: create, clarify and batch return `filed` (where the record went) exactly as the real tool
 * does (the stub builds them with the same `describeFiling`).
 * The cases `vague-record`, `obvious-task`, `just-record` and `group-vague` check the rule "record at
 * once, ask ONE question only when the obligation has no next step or list".
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

import manageSharedTasks from "../../agent/lib/tools/manage_shared_tasks.ts";
import manageProjects from "../../agent/lib/tools/manage_projects.ts";
import { projectInput } from "../../agent/lib/projects/project-contract.ts";
import { formatTaskProjectsContext } from "../../agent/lib/projects/project-context.ts";
import type { ProjectListing } from "../../agent/lib/shared-task-access.ts";
import { modeInstructions } from "../../agent/lib/prompt/mode-instructions.ts";
import { sharedTaskInput } from "../../agent/lib/shared-tasks.ts";
import { describeAdoptedClosures, describeFiling } from "../../agent/lib/task-filing.ts";
import { createConfiguredLanguageModel } from "../../agent/lib/model-transport.ts";
import { modelProviderConfig } from "../../agent/lib/model-provider-config.ts";

const argument = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const out = argument("out") ?? ".tmp/evals/task-requests";
const samples = Number(argument("samples") ?? "2");
const maxRequests = Number(argument("max-requests"));
const MAX_STEPS = 3;

interface Call { input: Record<string, unknown>; tool: string; valid: boolean }
interface Case {
  environment: "family" | "private";
  expect: (calls: readonly Call[], finalText: string) => string | null;
  key: string;
  message: string;
  /** Проекты области, как их покажет блок `<task_projects>` (по умолчанию пусто, как в новой области). */
  projects?: readonly ProjectListing[];
  /** Дела области для `list`, согласованные с проектами случая (по умолчанию общий реестр). */
  tasks?: readonly Record<string, unknown>[];
}

// Реестр по образцу прода 21 сентября (названия обезличены): то, что модель увидит в list.
const REGISTRY = [
  { id: "6cd4c57b-34bd-4c64-a882-b973bb577c62", title: "Отправить документы в банк: паспорт, СНИЛС и справки" },
  { id: "339b444f-a64d-45fa-b593-b95a8194ada8", title: "Сканировать документы" },
  { id: "3c650029-e0f0-4604-af66-6b1268ea01ce", title: "Назначить встречу с Олегом по стратегии" },
  { id: "aa70d3d7-03d3-434d-8955-8d2e5082e1a6", title: "Встреча с Олегом — четверг следующей недели" },
  { id: "5f0e0f7c-1a1a-4b1b-8c1c-000000000001", title: "Отвезти Опель на ремонт и зарядить его" },
  { id: "5f0e0f7c-1a1a-4b1b-8c1c-000000000002", title: "Найти репетитора по математике для сына" },
].map((task, index) => ({ ...task, kind: "task", source: "Личное", status: "accepted", version: 2 + index % 2 }));

// Семейный реестр по образцу прода 1 октября 2026: ничьи дела переезда и одно дело Юли.
const FAMILY_REGISTRY = [
  { id: "a0000000-0000-4000-8000-000000000001", title: "Встретить мебельщиков", status: "open", assignee: null },
  { id: "a0000000-0000-4000-8000-000000000002", title: "Встретить матрас", status: "open", assignee: null },
  { id: "a0000000-0000-4000-8000-000000000003", title: "Выкинуть мусор", status: "open", assignee: null },
  { id: "a0000000-0000-4000-8000-000000000004", title: "Купить щётку для посуды", status: "accepted", assignee: "Юля" },
].map((task, index) => ({ ...task, kind: "task", scope: "family", source: "Семья", version: 1 + index % 2 }));

const reads = (calls: readonly Call[]) => calls.filter((call) => ["list", "lists", "get"].includes(String(call.input.action))).length;
const batchItems = (calls: readonly Call[], action: string) => calls
  .flatMap((call) => call.input.action === "batch" ? (call.input.items as Record<string, unknown>[]) : [call.input])
  .filter((item) => item.action === action);

const questions = (text: string) => (text.match(/\?/gu) ?? []).length;
const created = (calls: readonly Call[]) => batchItems(calls, "create").length;

const project = (title: string, extra: Partial<ProjectListing> = {}): ProjectListing => ({
  completedItemCount: 0, details: null, itemCount: 0, lifeArea: null, listName: title,
  projectId: `b0000000-0000-4000-8000-${String(title.length).padStart(12, "0")}`, source: "Личное", status: "accepted",
  unfinishedItemCount: 1, version: 1, ...extra,
});

const CASES: Case[] = [
  {
    environment: "private", key: "dictated-list",
    message: "Занеси в список дел. Нам нужно найти людей, кто которые повесят шторы. Нужно починить опель. Нужночи. Починить и продать опель. Нужно. Нужно аккумулятор. Аккумулятор нужно зарядить опеля.. Нужно матрасы свести отвезти Матрас и свет увести в новую квартиру. Найти репетитора по математике для сына.",
    expect: (calls) => {
      const creates = batchItems(calls, "create").length;
      const batches = calls.filter((call) => call.input.action === "batch").length;
      return batches === 1 && creates >= 4 ? null : `batches=${batches} creates=${creates}`;
    },
  },
  {
    environment: "private", key: "unclear-close",
    message: "а я это уже сделал - закрой этим задачи - и у меня есть еще больше дел есть ведьъъ",
    expect: (calls, text) => {
      const closed = batchItems(calls, "complete").length;
      // Уточнение может быть вопросом или просьбой назвать дела: важно, что ничего не закрыто и реестр не перебирался.
      return reads(calls) <= 1 && closed === 0 && text.trim().length > 0 ? null : `reads=${reads(calls)} closed=${closed}`;
    },
  },
  {
    environment: "private", key: "explicit-close",
    message: "Отправку документов и встречу с Олегом я сделал, закрой их",
    // Решение владельца 21 сентября: закрыть все подходящие дела одним вызовом и перечислить их,
    // ошибку исправит reopen. Названные два обязаны быть среди закрытых, чужие дела трогать нельзя.
    expect: (calls, text) => {
      const ids = batchItems(calls, "complete").map((item) => String(item.id));
      const named = ["6cd4c57b-34bd-4c64-a882-b973bb577c62", "aa70d3d7-03d3-434d-8955-8d2e5082e1a6"];
      const related = new Set([...named, "339b444f-a64d-45fa-b593-b95a8194ada8", "3c650029-e0f0-4604-af66-6b1268ea01ce"]);
      const writes = calls.filter((call) => call.input.action === "batch" || call.input.action === "complete").length;
      const ok = named.every((id) => ids.includes(id)) && ids.every((id) => related.has(id)) && writes === 1 && reads(calls) <= 1 && text.trim().length > 0;
      return ok ? null : `closed=${ids.length} writes=${writes} reads=${reads(calls)}`;
    },
  },
  {
    environment: "family", key: "who-takes",
    message: "Надо заказать фильтры, кто возьмёт?",
    expect: (calls) => batchItems(calls, "create").some((item) => item.unassigned === true) ? null : "no unassigned create",
  },
  {
    environment: "private", key: "vague-record",
    message: "Надо разобраться с кружком для Дани",
    // Записать сразу, переслать место записи и задать ровно один вопрос с вариантами.
    expect: (calls, text) => {
      // Место записи бывает «пока без списка», сфера или список: модель вправе выбрать сама. Важно, что
      // строка filed дошла до человека и вопрос один, про первый шаг.
      const forwarded = text.includes("• «Разобраться с кружком") || text.includes("пока без списка");
      const ok = created(calls) === 1 && forwarded && questions(text) === 1 && /когда-нибудь|шаг|начн|начать|перв/iu.test(text);
      return ok ? null : `creates=${created(calls)} forwarded=${forwarded} questions=${questions(text)}`;
    },
  },
  {
    environment: "private", key: "obvious-task",
    message: "Купить батарейки",
    // Очевидное действие: записать и переслать место, без вопроса.
    expect: (calls, text) => {
      const ok = created(calls) === 1 && text.includes("пока без списка") && questions(text) === 0;
      return ok ? null : `creates=${created(calls)} forwarded=${text.includes("пока без списка")} questions=${questions(text)}`;
    },
  },
  {
    environment: "private", key: "just-record",
    message: "Просто запиши: разобраться с кружком для Дани, разберём потом",
    expect: (calls, text) => {
      const ok = created(calls) === 1 && questions(text) === 0;
      return ok ? null : `creates=${created(calls)} questions=${questions(text)}`;
    },
  },
  {
    environment: "family", key: "group-vague",
    message: "Надо разобраться с кружком для Дани",
    // Неадресованное сообщение в группе: записать, без допроса.
    expect: (calls, text) => {
      const ok = created(calls) === 1 && questions(text) === 0;
      return ok ? null : `creates=${created(calls)} questions=${questions(text)}`;
    },
  },
  {
    environment: "family", key: "own-task-in-group",
    message: "Надо найти мастеров, которые повесят шторы",
    // Слова автора о себе: дело на него, без `unassigned` и без поручения другому.
    expect: (calls) => {
      const made = batchItems(calls, "create");
      const bad = made.filter((item) => item.unassigned === true || item.assigneeRef !== undefined).length;
      return made.length === 1 && bad === 0 ? null : `creates=${made.length} unassignedOrAssigned=${bad}`;
    },
  },
  {
    environment: "family", key: "close-unowned",
    message: "Мебельщиков встретил, матрас привезли, мусор выкинул. Закрой эти дела",
    // Ничьи дела закрываются одним пакетом без «claim»; чужое дело Юли не трогаем; человеку не говорят «нет прав».
    expect: (calls, text) => {
      const ids = batchItems(calls, "complete").map((item) => String(item.id));
      const want = FAMILY_REGISTRY.slice(0, 3).map((task) => task.id);
      const claims = batchItems(calls, "claim").length;
      const writes = calls.filter((call) => call.input.action === "batch" || call.input.action === "complete").length;
      const ok = want.every((id) => ids.includes(id)) && !ids.includes(FAMILY_REGISTRY[3]!.id) && claims === 0 && writes === 1
        && !/нет прав/iu.test(text) && text.trim().length > 0;
      return ok ? null : `closed=${ids.length} claims=${claims} writes=${writes} noRights=${/нет прав/iu.test(text)}`;
    },
  },
  {
    environment: "family", key: "project-from-outcome",
    message: "Хотим в августе съездить в отпуск недели на две, надо всё организовать",
    // Результат из нескольких шагов: проект сразу с первым шагом, одним вызовом.
    expect: (calls) => {
      const made = calls.filter((call) => call.tool === "manage_projects" && call.input.action === "create");
      const step = made.some((call) => (call.input.nextStep as { title?: string } | undefined)?.title);
      return made.length === 1 && step ? null : `projectCreates=${made.length} withStep=${step}`;
    },
  },
  {
    environment: "private", key: "existing-project",
    projects: [project("Переезд", { itemCount: 5, completedItemCount: 3, unfinishedItemCount: 2 }), project("Работа", { itemCount: 4 })],
    message: "надо заказать матрас в новую квартиру",
    // Дело подходит по смыслу к «Переезду»: идёт в него названием из блока, нового проекта нет.
    expect: (calls) => {
      const made = batchItems(calls, "create");
      const inProject = made.length === 1 && String(made[0]!.listName ?? "").toLowerCase() === "переезд";
      const newProject = calls.some((call) => call.tool === "manage_projects" && call.input.action === "create");
      return inProject && !newProject ? null : `creates=${made.length} listName=${String(made[0]?.listName)} newProject=${newProject}`;
    },
  },
  {
    environment: "private", key: "new-theme",
    projects: [project("Переезд", { itemCount: 5, unfinishedItemCount: 2 }), project("Работа", { itemCount: 4 })],
    message: "Хочу в этом году выучиться водить мотоцикл: сначала курсы, потом права, потом выбрать сам мотоцикл",
    // Новая тема из нескольких шагов: свой проект с первым шагом, а не чужой «Переезд» или «Работа».
    expect: (calls) => {
      const made = calls.filter((call) => call.tool === "manage_projects" && call.input.action === "create");
      const title = String(made[0]?.input.title ?? "");
      const step = Boolean((made[0]?.input.nextStep as { title?: string } | undefined)?.title);
      return made.length === 1 && step && !/переезд|работа/iu.test(title) ? null : `projectCreates=${made.length} title=${title} withStep=${step}`;
    },
  },
  {
    environment: "family", key: "tidy-shared",
    projects: [project("Дом", { itemCount: 6, source: "Семья", unfinishedItemCount: 4 }), project("Квартира", { itemCount: 3, source: "Семья", unfinishedItemCount: 2 })],
    tasks: ["Купить диван", "Повесить полки", "Заказать шторы", "Выбрать лампу", "Забрать матрас", "Купить коврик"].map((title, index) => ({
      id: `c0000000-0000-4000-8000-00000000000${index}`, kind: "task", listName: index < 3 ? "Дом" : "Квартира", source: "Семья", status: "accepted", title, version: 1 })),
    message: "наведи порядок в проектах",
    // Общие проекты: предлагает слить или переименовать и ничего не меняет без «да».
    expect: (calls, text) => {
      const writes = calls.filter((call) => call.tool === "manage_projects" && ["merge", "update", "cancel", "complete"].includes(String(call.input.action))).length;
      const proposes = /слить|слива|объедин|переимен|закрыть/iu.test(text) && (/\?/u.test(text) || /скажи|сказать|как лучше|хочешь|твоего слова/iu.test(text));
      return writes === 0 && proposes ? null : `writes=${writes} proposes=${proposes}`;
    },
  },
  {
    environment: "private", key: "close-project-reply",
    projects: [project("Переезд", { itemCount: 4, completedItemCount: 4, unfinishedItemCount: 0 })],
    message: "да, закрой проект Переезд",
    // Закрывает проект тем же ходом: читает id и version из list и вызывает complete.
    expect: (calls) => {
      const done = calls.filter((call) => call.tool === "manage_projects" && call.input.action === "complete");
      const withIds = done.every((call) => call.input.id && call.input.version !== undefined);
      return done.length === 1 && withIds ? null : `completes=${done.length} withIds=${withIds}`;
    },
  },
  {
    environment: "family", key: "chatter",
    message: "ок, спасибо",
    expect: (calls, text) => calls.length === 0 && text.trim() === "<telegram-silent>" ? null : `calls=${calls.length} text=${text.slice(0, 60)}`,
  },
];

const caseCount = argument("cases")?.split(",").length ?? CASES.length;
const planned = caseCount * samples * MAX_STEPS;
console.error(`paid requests planned: up to ${planned} (${caseCount} cases × ${samples} samples × ≤${MAX_STEPS} steps; cached cells are skipped); about 30k input tokens each, mostly cached`);
if (process.argv.includes("--dry")) process.exit(0);
if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error("AGENT_EVAL_MAX_REQUESTS_REQUIRED");
if (planned > maxRequests) throw new Error(`AGENT_EVAL_REQUEST_CAP_EXCEEDED: ${planned} > ${maxRequests}`);
const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) throw new Error("AGENT_EVAL_MODEL_KEY_MISSING");
// Production runs with thinking disabled; `--reasoning-none` reproduces it.
const transport = process.argv.includes("--reasoning-none")
  ? { ...modelProviderConfig.agent.transport, reasoning: { type: "none" as const } }
  : modelProviderConfig.agent.transport;
const model = createConfiguredLanguageModel({ apiKey, maxOutputTokens: 16_000, modelId: modelProviderConfig.agent.models.primary.id, transport });
const core = await readFile("agent/instructions.md", "utf8");
const tool = {
  description: manageSharedTasks.description,
  inputSchema: z.toJSONSchema(sharedTaskInput, { io: "input" }) as never,
  name: "manage_shared_tasks",
  type: "function" as const,
};

const projectsTool = {
  description: manageProjects.description,
  inputSchema: z.toJSONSchema(projectInput, { io: "input" }) as never,
  name: "manage_projects",
  type: "function" as const,
};

function projectStub(input: Record<string, unknown>, listed: readonly ProjectListing[]): unknown {
  const parsed = projectInput.safeParse(input);
  if (!parsed.success) return { error: { code: "AGENT_PROJECT_INPUT_INVALID", message: parsed.error.issues.map((issue) => issue.message).join("; ") } };
  const view = (row: ProjectListing) => ({ completed: row.completedItemCount, hasNextStep: row.unfinishedItemCount > 0, id: row.projectId,
    open: row.unfinishedItemCount, source: row.source, status: row.status, title: row.listName, total: row.itemCount, version: row.version });
  if (input.action === "list") return { projects: listed.map(view) };
  if (input.action === "create") {
    const made = project(String(input.title), { itemCount: input.nextStep ? 1 : 0, unfinishedItemCount: input.nextStep ? 1 : 0 });
    return { created: true, nextStep: input.nextStep ? { id: "b1000000-0000-4000-8000-000000000001", title: (input.nextStep as { title: string }).title } : null, project: view(made) };
  }
  const found = listed.find((row) => row.projectId === input.id);
  if (!found) return { error: { code: "AGENT_TASK_ACCESS_DENIED", message: "Проект недоступен" } };
  if (input.action === "complete" && found.unfinishedItemCount > 0) {
    return { error: { code: "AGENT_PROJECT_HAS_OPEN_TASKS", message: "В проекте есть открытые дела" } };
  }
  return { detachedTasks: [], mergedInto: null, project: view(found) };
}

function userMessage(testCase: Case): string {
  if (testCase.environment === "private") return testCase.message;
  const current = { sourceSequence: "41", senderDisplayName: "Анна", senderUsername: "anna", triggeredBy: "unaddressed", text: testCase.message };
  return `<current_telegram_message>\n${JSON.stringify(current)}\n</current_telegram_message>`;
}

// Заглушка проверяет вход настоящей схемой: поле, которое инструмент отверг бы, считается ошибкой.
function stubResult(input: Record<string, unknown>, environment: Case["environment"], toolName = "manage_shared_tasks", listed: readonly ProjectListing[] = [], registry?: readonly Record<string, unknown>[]): unknown {
  if (toolName === "manage_projects") return projectStub(input, listed);
  const parsed = sharedTaskInput.safeParse(input);
  if (!parsed.success) return { error: { code: "AGENT_TASK_INPUT_INVALID", message: parsed.error.issues.map((issue) => issue.message).join("; ") } };
  const source = environment === "family" ? "Семья" : "Личное";
  // Как репозиторий: в личке нет свободных дел и поручений другому, пакет с таким пунктом отклоняется целиком.
  const items = input.action === "batch" ? input.items as Record<string, unknown>[] : [input];
  const personalDenied = environment === "private" ? items.findIndex((item) => item.unassigned === true || item.assigneeRef !== undefined) : -1;
  if (personalDenied >= 0) {
    return { error: { code: input.action === "batch" ? "AGENT_TASK_BATCH_REJECTED" : "AGENT_TASK_ACCESS_DENIED",
      message: `Пакет не применён, ничего не изменено. Не прошли пункты: #${personalDenied + 1} AGENT_TASK_ACCESS_DENIED` } };
  }
  if (input.action === "list") {
    return { incomplete: false, nextCursor: null, tasks: registry ?? (environment === "family" ? FAMILY_REGISTRY : REGISTRY), truncated: false };
  }
  const scope = environment === "family" ? "family" : "personal";
  const shaped = (item: Record<string, unknown>, index: number) => ({
    assignee: item.unassigned ? null : "Анна", dueAt: null, dueOn: item.dueOn ?? null,
    id: item.id ?? `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, kind: item.kind ?? "task",
    lifeArea: item.lifeArea ?? null, listName: item.listName ?? null, scope, source,
    status: item.action === "create" || item.action === undefined
      ? (item.unassigned ? "open" : "accepted") : item.action === "clarify" ? "accepted" : "completed",
    title: item.title ?? "дело", version: 1,
  });
  // Как настоящий инструмент: место записи собирает код, а не модель. Директива не сворачивать ставит
  // канал, в ответ инструмента её нет.
  const filing = (tasks: ReturnType<typeof shaped>[]) => describeFiling(tasks, "Europe/Moscow");
  // Закрытие ничьего дела записывает его на закрывшего, а ответ несёт `notice`, как репозиторий.
  const adoptedNotice = (list: Record<string, unknown>[]) => {
    const adopted = list.filter((item) => item.action === "complete" && FAMILY_REGISTRY.some((task) => task.id === item.id && task.status === "open"))
      .map((item) => ({ assignee: "Анна", title: FAMILY_REGISTRY.find((task) => task.id === item.id)!.title }));
    const text = environment === "family" ? describeAdoptedClosures(adopted) : null;
    return text === null ? {} : { notice: text };
  };
  if (input.action === "batch") {
    const list = input.items as Record<string, unknown>[];
    const tasks = list.map(shaped);
    const filedTasks = tasks.filter((_, index) => ["create", "clarify"].includes(String(list[index]!.action)));
    return { applied: list.length, note: "Пакет применён целиком. Не повторяй его пункты по одному",
      replayed: false, tasks, ...(filedTasks.length > 0 ? filing(filedTasks) : {}), ...adoptedNotice(list) };
  }
  const task = shaped(input, 99);
  return { replayed: false, task, ...(["create", "clarify"].includes(String(input.action)) ? filing([task]) : {}), ...adoptedNotice([input]) };
}

const hasError = (value: unknown) => typeof value === "object" && value !== null && "error" in value;

interface Cell { calls: Call[]; error?: string; failure: string | null; text: string }
async function run(testCase: Case): Promise<Cell> {
  const system = `${core}\n\n${modeInstructions({ environment: testCase.environment })}`;
  // Как на проде: блок проектов области идёт отдельным сообщением контекста перед текущим.
  const prompt: unknown[] = [
    { content: system, role: "system" },
    { content: [{ text: formatTaskProjectsContext(testCase.projects ?? []), type: "text" }], role: "user" },
    { content: [{ text: userMessage(testCase), type: "text" }], role: "user" },
  ];
  const calls: Call[] = [];
  let text = "";
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const result = await model.doGenerate({
      abortSignal: AbortSignal.timeout(300_000), maxOutputTokens: 16_000, prompt: prompt as never,
      toolChoice: { type: "auto" }, tools: [tool, projectsTool],
    });
    const toolCalls = result.content.flatMap((part) => part.type === "tool-call" ? [part] : []);
    text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    if (toolCalls.length === 0) break;
    prompt.push({ content: toolCalls.map((call) => ({ input: JSON.parse(call.input), toolCallId: call.toolCallId, toolName: call.toolName, type: "tool-call" })), role: "assistant" });
    prompt.push({ content: toolCalls.map((call) => {
      const input = JSON.parse(call.input) as Record<string, unknown>;
      const valid = call.toolName === "manage_projects" ? projectInput.safeParse(input).success : sharedTaskInput.safeParse(input).success;
      calls.push({ input, tool: call.toolName, valid });
      return { output: { type: "json", value: stubResult(input, testCase.environment, call.toolName, testCase.projects ?? [], testCase.tasks) }, toolCallId: call.toolCallId, toolName: call.toolName, type: "tool-result" };
    }), role: "tool" });
  }
  const invalid = calls.filter((call) => !call.valid || hasError(stubResult(call.input, testCase.environment, call.tool, testCase.projects ?? [], testCase.tasks))).length;
  return { calls, failure: invalid > 0 ? `invalid calls=${invalid}` : testCase.expect(calls, text), text };
}

await mkdir(out, { mode: 0o700, recursive: true });
const path = `${out}/results.json`;
const results: Record<string, Cell[]> = await readFile(path, "utf8").then(JSON.parse).catch(() => ({}));
// --cases a,b прогоняет только выбранные случаи.
const only = argument("cases")?.split(",");
const selected = only ? CASES.filter((testCase) => only.includes(testCase.key)) : CASES;
for (const testCase of selected) {
  for (let sample = 0; sample < samples; sample += 1) {
    const cells = results[testCase.key] ??= [];
    if (cells[sample] && !cells[sample]!.error) continue;
    try { cells[sample] = await run(testCase); }
    catch (error) { cells[sample] = { calls: [], error: String(error).slice(0, 300), failure: "error", text: "" }; }
    const cell = cells[sample]!;
    console.error(`${testCase.key}#${sample} ${cell.failure === null ? "PASS" : `FAIL ${cell.failure}`}`);
    await writeFile(path, JSON.stringify(results, null, 1), { mode: 0o600 });
  }
}
for (const testCase of selected) {
  const cells = results[testCase.key] ?? [];
  console.log(`${testCase.key}: ${cells.filter((cell) => cell.failure === null).length}/${cells.length} pass`);
}
