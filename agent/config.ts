/**
 * Stable application configuration.
 *
 * Exports:
 * - Agent compaction, per-turn model safety, session lifecycle, attachment, update, and timeout constants.
 * - Internal service locations and sandbox runner execution limits.
 * - Telegram group journal and proactive delivery model-context limits.
 * - Cross-process advisory-lock namespaces for sensitive workspace state.
 * - Bounded credentialed Google Workspace command execution.
 * - Installation-size settings (drains, private-burst windows) read from the environment.
 * - `requireRuntimeEnvironment`: reads required environment-specific values.
 */
import { z } from "zod";
import { AppError } from "./lib/app-error.js";
import { integerSetting } from "./lib/runtime-tuning.js";
import { readTelegramAgentIdentity } from "./lib/telegram-agent-identity.js";
import { telegramBotUsernames } from "./lib/telegram-bot-usernames.js";

export const AGENT_COMPACTION_THRESHOLD = 0.75;
// Eve compacts at threshold × context window. A million-token window would let a session grow to
// 750k tokens that every turn re-sends at cache-miss price, so the working window is capped: with
// the threshold above compaction starts near 120k tokens regardless of what the model supports.
export const AGENT_COMPACTION_CONTEXT_WINDOW_TOKENS = 160_000;
// The model may perform substantial tool work, but one turn must never consume unbounded calls.
export const AGENT_MAX_MODEL_STEPS_PER_TURN = 32;
export const GROQ_TRANSCRIPTION_TIMEOUT_MS = 60_000;
export const GOOGLE_WORKSPACE_PROFILE_LOCK_HASH_SEED = 2;
export const GOOGLE_WORKSPACE_COMMAND_TIMEOUT_MS = 60_000;
// A query at or above this stays in the log with its shape, never its parameters: finding where a
// turn spent its time used to require switching production statement logging on and waiting.
export const DATABASE_SLOW_QUERY_MS = 150;
export const SANDBOX_RUNNER_BASE_URL = "http://sandbox-runner:8080";
export const SESSION_INACTIVITY_DAYS = 30;
// A private chat starts a new session after this many quiet hours: memory, tasks and the recent
// chat timeline carry over, yesterday's full history does not (14 September 2026).
export const SESSION_PRIVATE_INACTIVITY_HOURS = 12;
// The owner hears about a DeepSeek balance below this before the bot loses its model (402).
export const DEEPSEEK_BALANCE_ALERT_USD = 2;
export const MODEL_USAGE_RETENTION_DAYS = 30;
/** Spend of a group without a family must outlive a whole UTC month for its budget (migration 177). */
export const FAMILYLESS_USAGE_RETENTION_DAYS = 40;
export const MODEL_USAGE_PURGE_BATCH_SIZE = 1_000;
// Completed Telegram updates are only data once Telegram can no longer redeliver them (security review, 5 October 2026).
export const TELEGRAM_INGRESS_RETENTION_DAYS = 30;
export const TELEGRAM_INGRESS_PURGE_BATCH_SIZE = 500;
export const SESSION_GROUP_ROTATION_LOCK_HASH_SEED = 3;
// The local Workflow world replays cumulative filesystem artifacts. Rotate with enough headroom
// below the observed Eve 240-second replay failure at 118 completed production turns.
export const SESSION_MAX_COMPLETED_TURNS = 50;
export const SESSION_RETENTION_LEASE_MS = 15 * 60 * 1_000;
// A deletion that failed waits this long before the sweep tries it again (upstream 63d7e65).
// Parking such a session forever kept its Workflow run alive, and every agent start re-read the
// whole event log of each one.
export const SESSION_RETENTION_FAILURE_COOLDOWN_MINUTES = 60;
export const SESSION_RETENTION_DAYS = 1;
export const SESSION_TASK_ABANDONED_DAYS = 7;
export const SESSION_TASK_MAX_ACTIVE_PER_GROUP_TOPIC = 25;
export const SESSION_TASK_SWEEP_BATCH_SIZE = 100;
export const PROACTIVE_DELIVERY_CONTEXT_MAX_AGE_DAYS = 30;
export const PROACTIVE_DELIVERY_CONTEXT_MAX_CHARACTERS = 12_000;
export const PROACTIVE_DELIVERY_CONTEXT_MAX_ITEMS = 10;
export const PROACTIVE_DELIVERY_HISTORY_DEFAULT_LIMIT = 10;
export const PROACTIVE_DELIVERY_HISTORY_MAX_LIMIT = 50;
export const SOFTWARE_UPDATE_GITHUB_RESPONSE_MAX_BYTES = 1024 * 1024;
export const SOFTWARE_UPDATE_HTTP_TIMEOUT_MS = 15_000;
export const SOFTWARE_UPDATE_MANIFEST_MAX_BYTES = 64 * 1024;
// Мягко удалённый факт остаётся восстановимым это окно, затем вычищается физически вместе со
// связанными чанками и заявлениями по каскадам базовой таблицы.
export const MEMORY_SOFT_DELETE_RETENTION_DAYS = 30;
export const MEMORY_SOFT_DELETE_PURGE_BATCH_SIZE = 200;
export const TELEGRAM_API_REQUEST_TIMEOUT_MS = 15_000;
// An unanswered approval parks the Eve turn indefinitely: Eve keeps `session.waiting` for as long
// as it takes. The confirmation window bounds that wait so one ignored prompt cannot freeze a chat.
export const TELEGRAM_HITL_APPROVAL_TIMEOUT_MS = 5 * 60 * 1_000;
// One `respond` waits up to Eve's 30-second command-hook handover, so the lease must outlast a whole
// batch; a lease that expires mid-flight would let the next minute answer the same request twice.
export const TELEGRAM_HITL_TIMEOUT_LEASE_MS = 15 * 60 * 1_000;
export const TELEGRAM_HITL_TIMEOUT_SWEEP_BATCH_SIZE = 5;
export const TELEGRAM_HITL_TIMEOUT_SWEEP_TIMEOUT_MS = 180 * 1_000;
// The timeout sweep needs a route-scoped `attachSession`, which exists only inside an HTTP handler,
// so the minute schedule calls the agent's own private route. The port is fixed by `npm start`.
export const AGENT_INTERNAL_SELF_BASE_URL = "http://127.0.0.1:3000";
export const TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS = 12_000;
export const TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES = 100;
export const TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES = 10_000;
// An existing session sees only journal entries it has not seen, because its own turns live in
// Eve history. Since delivery context of past turns is dropped from the prompt, a message that
// never started a turn was visible for exactly one turn. A small recent window rides along with
// every turn so the model keeps the last exchanges of the chat in front of it.
export const TELEGRAM_GROUP_JOURNAL_RECENT_WINDOW_MESSAGES = 15;
export const TELEGRAM_GROUP_JOURNAL_RECENT_WINDOW_CHARACTERS = 3_000;
export const TELEGRAM_ATTACHMENT_REFERENCE_LIST_DEFAULT_LIMIT = 50;
export const TELEGRAM_ATTACHMENT_REFERENCE_LIST_MAX_LIMIT = 50;
export const TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED = 1;
export const TELEGRAM_INGRESS_LEASE_MS = 15 * 60 * 1_000;
// Each drain holds its chat until the turn reaches a session boundary, so this is the number of
// turns the whole bot runs at once; callback drains answer buttons beside them. One family on one
// core keeps the defaults, many families on a bigger machine raise them (port of ilkruglov
// 5e7604c2); Workflow steps are bounded separately by WORKFLOW_POSTGRES_WORKER_CONCURRENCY.
export const TELEGRAM_INGRESS_MAX_CONCURRENT_DRAINS = integerSetting(
  "TELEGRAM_INGRESS_MAX_CONCURRENT_DRAINS",
  { absent: 3, min: 1, max: 100 },
);
export const TELEGRAM_INGRESS_MAX_CONCURRENT_CALLBACK_DRAINS = integerSetting(
  "TELEGRAM_INGRESS_MAX_CONCURRENT_CALLBACK_DRAINS",
  { absent: 2, min: 1, max: 100 },
);
// A person often sends several messages in a row (26 September 2026: five private messages in a
// minute gave five turns). A private chat's head is claimed only after the chat has been quiet this
// long, so the series behind it is complete; a steady stream waits at most the cap. Both are
// tunable: the quiet window is paid on every private message, so an installation that values
// the answer's speed over series completeness can shorten it.
export const TELEGRAM_PRIVATE_BURST_QUIET_MS = integerSetting(
  "TELEGRAM_PRIVATE_BURST_QUIET_MS",
  { absent: 2_000, min: 0, max: 60_000 },
);
export const TELEGRAM_PRIVATE_BURST_MAX_WAIT_MS = integerSetting(
  "TELEGRAM_PRIVATE_BURST_MAX_WAIT_MS",
  { absent: 20_000, min: 0, max: 300_000 },
);
// The ingress claim repository rejects a cap below the quiet window on every claim, which would
// stop every chat after a start that passed; the pair is refused here instead.
if (TELEGRAM_PRIVATE_BURST_MAX_WAIT_MS < TELEGRAM_PRIVATE_BURST_QUIET_MS) {
  throw new AppError(
    "AGENT_RUNTIME_TUNING_INVALID",
    "TELEGRAM_PRIVATE_BURST_MAX_WAIT_MS не может быть меньше TELEGRAM_PRIVATE_BURST_QUIET_MS",
  );
}
export const TELEGRAM_MAX_INBOUND_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_MAX_ATTACHMENTS_PER_MESSAGE = 1;
export const TELEGRAM_MAX_OUTBOUND_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_VOICE_MAX_BYTES = 20 * 1024 * 1024;
export const WORKSPACE_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const WORKSPACE_DELETION_LEASE_MS = 15 * 60 * 1_000;
export const WORKSPACE_TOOL_MAX_TEXT_BYTES = 1024 * 1024;
export const VISION_MAX_FILE_BYTES = 10_000_000;

const secretTokenSchema = z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/u);

const runtimeEnvironmentSchema = z
  .object({
    AGENT_INTERNAL_TOKEN: secretTokenSchema,
    DATABASE_URL: z.string().min(1),
    GROQ_API_KEY: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    INVITATION_SIGNING_SECRET: z.string().min(32),
    MODEL_API_KEY: z.string().regex(/^\S+$/u),
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_BOT_USERNAME: z.string().min(1),
    // As long as the invitation signing secret, within what Telegram accepts for secret_token
    // (1-256 characters of A-Z, a-z, 0-9, `_` and `-`). Telegram holds it, so it guards only the
    // webhook; the drain route, the approval sweep and the workflow flow route take
    // AGENT_INTERNAL_TOKEN (port of ilkruglov b640f72b, 3c339144).
    TELEGRAM_WEBHOOK_SECRET_TOKEN: secretTokenSchema,
  })
  .refine((environment) => environment.AGENT_INTERNAL_TOKEN !== environment.TELEGRAM_WEBHOOK_SECRET_TOKEN, {
    message: "The internal token must differ from the webhook secret",
    path: ["AGENT_INTERNAL_TOKEN"],
  });

export function requireRuntimeEnvironment() {
  readTelegramAgentIdentity();
  const parsed = runtimeEnvironmentSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(
      `AGENT_REQUIRED_CONFIG_MISSING: Отсутствуют обязательные настройки: ${fields}`,
    );
  }
  // A malformed second @username stops the start instead of silently losing mentions by it.
  telegramBotUsernames(parsed.data.TELEGRAM_BOT_USERNAME);
  return parsed.data;
}
