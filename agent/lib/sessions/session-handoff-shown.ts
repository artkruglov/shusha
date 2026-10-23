/**
 * Marks the session handoff shown once Eve has taken the turn that carries it.
 *
 * Exports:
 * - `SESSION_HANDOFF_CARRIED_ATTRIBUTE`: the trusted turn attribute the inbound handler sets when
 *   the durable message carries the handoff (`telegram-turn-result.ts`).
 * - `markSessionHandoffShown`: on `turn.started`, marks the summary shown for such a turn; the
 *   mark is idempotent and a failure is logged, never thrown into the turn.
 *
 * Key construct:
 * - The inbound handler cannot mark it: Eve sends the message after the handler returns, and a
 *   failure in between would hide a summary the model never saw. `turn.started` is the first
 *   event after Eve accepted the message durably.
 */
import type { SessionContext } from "eve/context";

import { isAppError } from "../app-error.js";
import { applicationSessionId } from "./session-context.js";
import { sessionHandoffRepository } from "./session-handoff-repository.js";

export const SESSION_HANDOFF_CARRIED_ATTRIBUTE = "sessionHandoffCarried";
/** Attributes hold strings only; this is the one value that means "carried". */
export const SESSION_HANDOFF_CARRIED_VALUE = "true";

export async function markSessionHandoffShown(
  ctx: Pick<SessionContext, "session">,
  markShown: (applicationSessionId: string) => Promise<void> = (id) => sessionHandoffRepository.markShown(id),
): Promise<void> {
  if (ctx.session.auth.current?.attributes[SESSION_HANDOFF_CARRIED_ATTRIBUTE] !== SESSION_HANDOFF_CARRIED_VALUE) return;
  try {
    await markShown(applicationSessionId(ctx));
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_SESSION_HANDOFF_MARK_FAILED",
      error: isAppError(error) ? error.code : error instanceof Error ? error.name : "unknown",
      eveSessionId: ctx.session.id,
    }));
  }
}
