/**
 * Terminal transitions of a Telegram ingress update that failed.
 *
 * Exports:
 * - `ingressFailure`: the stable code and stored message of a drain failure.
 * - `settleIngressTransition`: runs one fail/release transition and logs its own error instead of
 *   letting it replace the original failure or stop the rest of the series from being released.
 *
 * Key construct:
 * - In Eve 0.40.0 `HookNotFoundError` never means «not delivered». `dispatchContinuation` turns a
 *   missing hook into `session_not_active` (`execution/workflow-runtime.js`, `dispatchWorkflowCommand`),
 *   and the channel address then calls `createSession`, which first `start()`s a run with this very
 *   message and only then waits 30 s for its hook (`waitForCommandHookOwner`). The error escapes only
 *   after that wait, so the message may still be answered: it fails as ambiguous, keeps its dispatch
 *   marker and is never dispatched again. A retry here once could answer one message twice.
 */
import { isAppError } from "./app-error.js";

function isHookMissing(error: unknown): boolean {
  return error instanceof Error && error.name === "HookNotFoundError";
}

export function ingressFailure(error: unknown): { code: string; message: string } {
  if (isHookMissing(error)) {
    return {
      code: "AGENT_TELEGRAM_SESSION_HOOK_AMBIGUOUS",
      message: "Сессия не подтвердила приём сообщения за отведённое время; повторная передача запрещена",
    };
  }
  return {
    code: isAppError(error) ? error.code : "AGENT_TELEGRAM_INGRESS_FAILED",
    message: isAppError(error) ? error.message : "Не удалось обработать сообщение Telegram",
  };
}

export async function settleIngressTransition(
  transition: "fail" | "release",
  updateId: string,
  originalCode: string,
  run: () => Promise<void>,
): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_TELEGRAM_INGRESS_TRANSITION_FAILED",
      error: error instanceof Error ? error.message : String(error),
      originalCode,
      transition,
      ...(isAppError(error) ? { transitionCode: error.code } : {}),
      updateId,
    }));
    return false;
  }
}
