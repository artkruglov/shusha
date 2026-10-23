/**
 * Common model-facing execution boundary for Eve tools.
 *
 * Exports:
 * - `wrapModelFacingTool`: preserves a descriptor while normalizing every thrown error and telling
 *   the model when its pre-tool text has already been delivered.
 * - `wrapModelFacingToolMap`: applies the boundary once to a complete mode-scoped surface.
 * - `jsonSafeToolOutput`: dates and bigints inside plain objects and arrays become strings.
 *
 * Key construct:
 * - Eve accepts only plain JSON from a tool and fails the call with ToolOutputSerializationError
 *   otherwise. Repositories hand back pg rows whose timestamp columns are `Date` objects, and the
 *   call fails after its write is already committed (port of ilkruglov 478b3d2, 30 September 2026).
 * - A tool runs inside the database scope of the family named by the verified session auth: under
 *   the runtime role, row-level security (migration 171) hides every other family's rows from a
 *   query that forgot its family filter.
 */
import { defineTool, type ToolDefinition } from "eve/tools";

import { requireToolSpaceAccess } from "./sessions/session-tool-space-access.js";

import { AppError, isAppError } from "./app-error.js";
import { isDatabaseFamilyId, withFamilyDatabaseContext, withGroupDatabaseContext } from "./database-context.js";
import { familylessGroupFromAuth } from "./familyless-group-auth.js";
import { ModelFacingError, normalizeModelFacingError } from "./model-facing-error.js";
import {
  PROGRESS_NOTICE_SENT_NOTE,
  progressNoticeKey,
  telegramProgressNoticeDeferral,
} from "./telegram-progress-deferral.js";
import {
  TOOL_REPEAT_WITHOUT_PROGRESS_CODE,
  toolCallFingerprint,
  TOOL_FAILING_REPEATEDLY_CODE,
  toolRepeatGuard,
} from "./tool-repeat-guard.js";

type AnyToolDefinition = ToolDefinition<any, any>;
type ApprovalPolicyFunction = (ctx: unknown) => unknown;

function turnKey(ctx: unknown): string | null {
  const session = (ctx as { session?: { id?: unknown; turn?: { id?: unknown } } } | undefined)
    ?.session;
  if (typeof session?.id !== "string" || typeof session.turn?.id !== "string") return null;
  return `${session.id}:${session.turn.id}`;
}

function failingRepeatedlyError(toolName: string): ModelFacingError {
  return new ModelFacingError({
    category: "operation",
    code: TOOL_FAILING_REPEATEDLY_CODE,
    correction:
      `${toolName} уже несколько раз подряд завершился ошибкой в этом ходе. ` +
      "Больше его не вызывайте: скажите человеку, что сейчас не получается, и что вы можете сделать без него.",
    reason: "Инструмент подряд отказывает в этом ходе; следующий вызов не даст нового результата.",
    retryable: false,
    sideEffectStatus: "not_started",
  });
}

function repeatWithoutProgressError(toolName: string): ModelFacingError {
  return new ModelFacingError({
    category: "operation",
    code: TOOL_REPEAT_WITHOUT_PROGRESS_CODE,
    correction:
      `Этот вызов ${toolName} с теми же аргументами уже завершился ошибкой в этом ходе. ` +
      "Не повторяйте его без изменений: измените аргументы или подход, либо сообщите пользователю, что не удалось, и дождитесь нового запроса.",
    reason: "Повтор вызова с теми же аргументами после ошибки не даёт нового результата.",
    retryable: false,
    sideEffectStatus: "not_started",
  });
}

/**
 * Eve treats an exception thrown by an approval policy as a failed model call and parks the whole
 * session for a manual retry. Input validation inside a policy is an ordinary correctable error,
 * so it becomes a denial with the reason the model can act on.
 */
function wrapApprovalPolicy(approval: unknown): unknown {
  if (typeof approval !== "function") return approval;
  const policy = approval as ApprovalPolicyFunction;
  return async (ctx: unknown) => {
    try {
      return await policy(ctx);
    } catch (error) {
      if (isAppError(error)) return { reason: error.message, type: "denied" };
      throw error;
    }
  };
}

// Generic call discipline lives once in `agent/instructions.md`; repeating it in every descriptor
// added roughly 17k characters to each model call without adding information.
export function wrapModelFacingTool(
  toolName: string,
  definition: AnyToolDefinition,
): AnyToolDefinition {
  return defineTool({
    ...definition,
    ...(definition.approval === undefined
      ? {}
      : { approval: wrapApprovalPolicy(definition.approval) as AnyToolDefinition["approval"] }),
    async execute(input, ctx) {
      const turn = turnKey(ctx);
      const fingerprint = turn === null ? null : toolCallFingerprint(toolName, input);
      if (turn !== null && fingerprint !== null && toolRepeatGuard.refuses(turn, fingerprint)) {
        throw repeatWithoutProgressError(toolName);
      }
      // Новые аргументы не помогают, когда не работает сам инструмент: продуктовый каталог
      // 22 сентября 2026 отвечал отказом, а модель звала его 21 раз подряд.
      if (turn !== null && toolRepeatGuard.exhausted(turn, toolName)) {
        throw failingRepeatedlyError(toolName);
      }
      let output: unknown;
      try {
        output = await inTurnScope(ctx, async () => {
          await requireToolSpaceAccess(ctx);
          return await definition.execute(input, ctx);
        });
      } catch (error) {
        if (turn !== null && fingerprint !== null) {
          toolRepeatGuard.recordFailure(turn, fingerprint, toolName);
        }
        throw normalizeModelFacingError(error, { toolName });
      }
      if (turn !== null && fingerprint !== null) {
        toolRepeatGuard.recordSuccess(turn, fingerprint, toolName);
      }
      return withDeliveredNoticeNote(jsonSafeToolOutput(output), ctx);
    },
  });
}

type ToolContext = Parameters<NonNullable<AnyToolDefinition["execute"]>>[1];

/**
 * The verified database scope of the turn. A turn of a group without a family (migration 175)
 * carries no family attribute at all and runs in that group's scope, which sees no family. Any other
 * verified session whose family is missing or not a string is refused: the system scope it used to
 * fall back to sees every family under RLS. Only a context with no auth at all (no channel starts
 * such a turn) and a non-uuid string (unit-test fixtures) keep the system scope.
 */
function inTurnScope<T>(ctx: ToolContext, work: () => Promise<T>): Promise<T> {
  const attributes = (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } | null } } })
    .session?.auth?.current?.attributes;
  const familyId = attributes?.familyId;
  const familyless = familylessGroupFromAuth(attributes);
  if (familyless) return withGroupDatabaseContext(familyless.groupId, work);
  if (attributes !== undefined && (typeof familyId !== "string" || familyId === "")) {
    throw new AppError("AGENT_DATABASE_SCOPE_MISSING", "У сессии нет проверенной семьи, инструмент не может работать");
  }
  return isDatabaseFamilyId(familyId) ? withFamilyDatabaseContext(familyId, work) : work();
}

/**
 * The model writes its final message right after this result. Without the note it answers every
 * topic again, and the person reads the pre-tool text twice.
 */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === null || prototype === Object.prototype;
}

/**
 * Only plain objects and arrays are walked: binary payloads, streams and class instances other than
 * `Date` pass through untouched, so Eve's own check still reports anything genuinely unsupported.
 */
export function jsonSafeToolOutput(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  if (Array.isArray(value)) {
    seen.add(value);
    const mapped = value.map((item) => jsonSafeToolOutput(item, seen));
    seen.delete(value);
    return mapped;
  }
  if (!isPlainObject(value)) return value;
  seen.add(value);
  const mapped = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafeToolOutput(item, seen)]));
  seen.delete(value);
  return mapped;
}

function withDeliveredNoticeNote(output: unknown, ctx: unknown): unknown {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return output;
  const session = (ctx as { session?: { id?: unknown; turn?: { id?: unknown } } } | undefined)
    ?.session;
  if (typeof session?.id !== "string" || typeof session.turn?.id !== "string") return output;
  if (!telegramProgressNoticeDeferral.wasSent(progressNoticeKey(session.id, session.turn.id))) {
    return output;
  }
  return { ...output, already_sent_to_user: PROGRESS_NOTICE_SENT_NOTE };
}

export function wrapModelFacingToolMap<T extends Readonly<Record<string, AnyToolDefinition>>>(
  surface: T,
): T {
  return Object.fromEntries(
    Object.entries(surface).map(([name, definition]) => [
      name,
      wrapModelFacingTool(name, definition),
    ]),
  ) as T;
}
