/** Do the coach's answers on a whole direction and on an hour for oneself go the way the contract asks? Paid live probe.
 * MODEL_API_KEY=… npx tsx stress/prompt-evals/care-and-time.ts --out .tmp/evals/care-1 --max-requests 24 [--samples 2] [--reasoning-none] [--dry]
 * Refuses above --max-requests and sends requests one at a time to share the cached prefix.
 *
 * 29 September 2026: production had no care areas and no personal-time windows because nobody started
 * the conversation. The coach now asks (`care_area_offer`, a rewritten `rest_window_missing`); this eval
 * checks what the model does with the answer: `claim` in one step, nothing on «пока нет», the areas named
 * without counting or comparing, the wish saved and the window set. The tools are declared, not executed:
 * every call gets a stub result, up to three steps.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

import { careAreaInput } from "../../agent/lib/care-areas/care-area-repository.ts";
import manageCareAreas from "../../agent/lib/tools/manage_care_areas.ts";
import managePersonalTime, { personalTimeInput } from "../../agent/lib/tools/manage_personal_time.ts";
import manageSharedTasks from "../../agent/lib/tools/manage_shared_tasks.ts";
import { modeInstructions } from "../../agent/lib/prompt/mode-instructions.ts";
import { sharedTaskInput } from "../../agent/lib/shared-tasks.ts";
import { chooseCoachTouch, type CoachFacts } from "../../agent/lib/initiative/coach.ts";
import { createConfiguredLanguageModel } from "../../agent/lib/model-transport.ts";
import { modelProviderConfig } from "../../agent/lib/model-provider-config.ts";

const argument = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const out = argument("out") ?? ".tmp/evals/care-and-time";
const samples = Number(argument("samples") ?? "2");
const maxRequests = Number(argument("max-requests"));
const MAX_STEPS = 3;

interface Call { input: Record<string, unknown>; tool: string }
interface Case {
  /** The coach touch the person is answering, taken from the real coach code. */
  coach: "care_area_offer" | "rest_window_missing" | null;
  expect: (calls: readonly Call[], text: string) => string | null;
  key: string;
  message: string;
}

const FACTS: CoachFacts = {
  enabled: true, familyRituals: 1, invited: true, invitesSent: 1, lastByReason: {}, lastTouchAt: null, ownedCareAreas: 0,
  openDecision: null, openSituation: null, personalWindows: 1, quietRitual: null, relation: "partner", touchesLastWeek: 0, weeklyReviewEnabled: false,
};
const COACH_TEXT = {
  care_area_offer: chooseCoachTouch(FACTS, { hour: 15, weekday: 3 }, new Date("2026-09-30T12:00:00Z"))!.text,
  rest_window_missing: chooseCoachTouch({ ...FACTS, ownedCareAreas: 1, personalWindows: 0 }, { hour: 15, weekday: 3 }, new Date("2026-09-30T12:00:00Z"))!.text,
};

const areaCalls = (calls: readonly Call[], action: string) => calls.filter((call) => call.tool === "manage_care_areas" && call.input.action === action);
// Сравнение и счёт нагрузки запрещены принципом продукта: число, процент, «больше чем у».
const COUNTS_OR_COMPARES = /\d+\s?%|процент|больше чем|меньше чем|сделал[аи]? больше|нагрузк/iu;

const CASES: Case[] = [
  {
    coach: "care_area_offer", key: "claim-area", message: "Садик и врачи веду я",
    expect: (calls) => {
      const claimed = areaCalls(calls, "claim").map((call) => String(call.input.title ?? "").toLowerCase());
      const ok = claimed.some((title) => /садик|врач/u.test(title)) && areaCalls(calls, "propose").length === 0;
      return ok ? null : `claims=${JSON.stringify(claimed)} proposes=${areaCalls(calls, "propose").length}`;
    },
  },
  {
    coach: "care_area_offer", key: "not-yet", message: "Пока нет",
    expect: (calls) => {
      const writes = calls.filter((call) => call.tool === "manage_care_areas" && ["create", "claim", "propose"].includes(String(call.input.action))).length;
      return writes === 0 ? null : `writes=${writes}`;
    },
  },
  {
    coach: null, key: "what-is-on-me", message: "что на мне сейчас?",
    expect: (calls, text) => {
      const read = calls.some((call) => call.tool === "manage_care_areas" && call.input.action === "list");
      const ok = read && /Машина/u.test(text) && !COUNTS_OR_COMPARES.test(text);
      return ok ? null : `read=${read} names=${/Машина/u.test(text)} counts=${COUNTS_OR_COMPARES.test(text)}`;
    },
  },
  {
    coach: "rest_window_missing", key: "free-hour", message: "Рисовать. По четвергам после восьми вечера",
    expect: (calls) => {
      const windows = calls.filter((call) => call.tool === "manage_personal_time" && call.input.action === "add");
      const thursday = windows.some((call) => call.input.weekday === 4 && String(call.input.startsAt ?? "") >= "20:00");
      return thursday ? null : `windows=${JSON.stringify(windows.map((call) => call.input))}`;
    },
  },
  {
    coach: null, key: "heavy-week", message: "Эта неделя просто жуть, я не вывожу",
    expect: (calls, text) => {
      // Сама ничего не двигает, пока человек не выбрал; вопрос с выходами, без счёта нагрузки.
      const mutating = calls.filter((call) => call.tool === "manage_shared_tasks"
        && !["list", "get"].includes(String(call.input.action))).length;
      const offers = /(\?|скажи, что)/iu.test(text) && /(отлож|когда-нибудь|партн|Юл|передать)/iu.test(text);
      const counts = COUNTS_OR_COMPARES.test(text) || /\b[3-9]\s+дел/u.test(text);
      return mutating === 0 && offers && !counts ? null : `mutating=${mutating} offers=${offers} counts=${counts}`;
    },
  },
];

const caseCount = argument("cases")?.split(",").length ?? CASES.length;
const planned = caseCount * samples * MAX_STEPS;
console.error(`paid requests planned: up to ${planned} (${caseCount} cases × ${samples} samples × ≤${MAX_STEPS} steps; cached cells are skipped); about 17k input tokens each, mostly cached`);
if (process.argv.includes("--dry")) process.exit(0);
if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error("AGENT_EVAL_MAX_REQUESTS_REQUIRED");
if (planned > maxRequests) throw new Error(`AGENT_EVAL_REQUEST_CAP_EXCEEDED: ${planned} > ${maxRequests}`);
const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) throw new Error("AGENT_EVAL_MODEL_KEY_MISSING");
const transport = process.argv.includes("--reasoning-none")
  ? { ...modelProviderConfig.agent.transport, reasoning: { type: "none" as const } }
  : modelProviderConfig.agent.transport;
const model = createConfiguredLanguageModel({ apiKey, maxOutputTokens: 16_000, modelId: modelProviderConfig.agent.models.primary.id, transport });
const core = await readFile("agent/instructions.md", "utf8");
const tools = [
  { description: manageCareAreas.description, inputSchema: z.toJSONSchema(careAreaInput, { io: "input" }) as never, name: "manage_care_areas", type: "function" as const },
  { description: managePersonalTime.description, inputSchema: z.toJSONSchema(personalTimeInput, { io: "input" }) as never, name: "manage_personal_time", type: "function" as const },
  { description: manageSharedTasks.description, inputSchema: z.toJSONSchema(sharedTaskInput, { io: "input" }) as never, name: "manage_shared_tasks", type: "function" as const },
];

// В семье уже есть области: та, что ведёт сам человек, и чужая, чтобы ответ «что на мне» можно было отличить.
const AREAS = [
  { id: "11111111-1111-4111-8111-111111111111", owner: "Ты", pendingOwner: null, status: "accepted", title: "Машина", version: 2 },
  { id: "22222222-2222-4222-8222-222222222222", owner: "Юля", pendingOwner: null, status: "accepted", title: "Школа", version: 3 },
  { id: "33333333-3333-4333-8333-333333333333", owner: null, pendingOwner: null, status: "open", title: "Платежи", version: 1 },
];

function stub(tool: string, input: Record<string, unknown>): unknown {
  if (tool === "manage_care_areas") {
    if (!careAreaInput.safeParse(input).success) return { error: { code: "AGENT_CARE_AREA_INPUT_INVALID" } };
    if (input.action === "list") return { areas: AREAS };
    return { area: { id: input.id ?? "44444444-4444-4444-8444-444444444444", owner: "Ты", pendingOwner: null, status: "accepted", title: input.title ?? "Область", version: 1 } };
  }
  if (tool === "manage_personal_time") {
    if (!personalTimeInput.safeParse(input).success) return { error: { code: "AGENT_PERSONAL_TIME_INPUT_INVALID" } };
    return input.action === "list" ? { windows: [] } : { window: { ...input, id: "55555555-5555-4555-8555-555555555555" } };
  }
  if (!sharedTaskInput.safeParse(input).success) return { error: { code: "AGENT_TASK_INPUT_INVALID" } };
  if (input.action === "list") {
    const task = (id: string, title: string, dueOn: string | null) => ({ dueOn, id, kind: "task", status: "open", title });
    return { incomplete: false, nextCursor: null, tasks: [
      task("77777777-7777-4777-8777-777777777771", "Сдать отчёт по проекту", "2026-10-02"),
      task("77777777-7777-4777-8777-777777777772", "Записать Даню к стоматологу", null),
      task("77777777-7777-4777-8777-777777777773", "Разобрать шкаф в детской", null),
    ], truncated: false };
  }
  return { replayed: false, task: { id: "66666666-6666-4666-8666-666666666666", kind: input.kind ?? "task", status: "accepted", title: input.title ?? "дело" },
    filed: `• «${String(input.title ?? "дело")}» → Для себя, видишь только ты` };
}

function userParts(testCase: Case): { text: string; type: "text" }[] {
  const deliveries = testCase.coach === null ? [] : [{
    content: COACH_TEXT[testCase.coach], deliveredAt: "2026-09-30T12:00:00.000Z", scheduledFor: "2026-09-30T12:00:00.000Z",
    sourceId: "ref", sourceKind: "coach", title: "Вопрос коуча",
  }];
  return [
    ...(deliveries.length === 0 ? [] : [{ text: `<recent_proactive_deliveries>\n${JSON.stringify({ deliveries })}\n</recent_proactive_deliveries>`, type: "text" as const }]),
    { text: testCase.message, type: "text" },
  ];
}

interface Cell { calls: Call[]; error?: string; failure: string | null; text: string }
async function run(testCase: Case): Promise<Cell> {
  const system = `${core}\n\n${modeInstructions({ environment: "private" })}`;
  const prompt: unknown[] = [{ content: system, role: "system" }, { content: userParts(testCase), role: "user" }];
  const calls: Call[] = [];
  let text = "";
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const result = await model.doGenerate({
      abortSignal: AbortSignal.timeout(300_000), maxOutputTokens: 16_000, prompt: prompt as never, toolChoice: { type: "auto" }, tools,
    });
    const toolCalls = result.content.flatMap((part) => part.type === "tool-call" ? [part] : []);
    text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    if (toolCalls.length === 0) break;
    prompt.push({ content: toolCalls.map((call) => ({ input: JSON.parse(call.input), toolCallId: call.toolCallId, toolName: call.toolName, type: "tool-call" })), role: "assistant" });
    prompt.push({ content: toolCalls.map((call) => {
      const input = JSON.parse(call.input) as Record<string, unknown>;
      calls.push({ input, tool: call.toolName });
      return { output: { type: "json", value: stub(call.toolName, input) }, toolCallId: call.toolCallId, toolName: call.toolName, type: "tool-result" };
    }), role: "tool" });
  }
  return { calls, failure: testCase.expect(calls, text), text };
}

await mkdir(out, { mode: 0o700, recursive: true });
const path = `${out}/results.json`;
const results: Record<string, Cell[]> = await readFile(path, "utf8").then(JSON.parse).catch(() => ({}));
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
