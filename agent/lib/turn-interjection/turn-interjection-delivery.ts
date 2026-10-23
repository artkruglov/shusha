/**
 * Records that the messages shown to a running turn reached a model call.
 *
 * Exports:
 * - `recordTurnInterjectionDelivery`: at model step N, marks claims returned during earlier steps as
 *   delivered and frees claims of an attempt Eve threw away.
 * - `finishTurnInterjectionDelivery`: at the end of the turn, the same rule against the last step,
 *   and the rest goes back to ordinary processing.
 *
 * Key constructs:
 * - A step starts only after every tool of the previous step has finished, so its prompt carries
 *   each result returned before it. The model's own action events are no proof: with parallel calls
 *   a fast tool can return while the model is still requesting the next one.
 * - Eve re-runs an interrupted step with the same index and the history of the completed attempt
 *   only (review, 28 September 2026): the step number, not the moment, decides what was delivered.
 * - A failed record is retried once; if both attempts fail the turn shows no new messages until a
 *   step is recorded again (`isTurnInterjectionDeliveryUntracked`), and a claim without a step
 *   number is freed, never delivered: a message may be answered twice, but it is never lost.
 */
import type { SessionAuth } from "eve/context";

import { turnInterjectionRepository } from "./turn-interjection-repository.js";
import { resolveTurnInterjectionScope } from "./turn-interjection-scope.js";

type DeliveryContext = { session: { auth: SessionAuth; id: string; parent?: unknown; turn: { id: string } } };
type Repository = Pick<typeof turnInterjectionRepository, "finishTurn" | "stepStarted">;

/**
 * Turns of this process whose current step could not be recorded. A result returned now would carry
 * a missing or stale step number and could later pass for delivered, so the turn shows no new
 * messages until a step is recorded again. After a crash the retried step records itself first.
 */
const untrackedTurns = new Set<string>();
const turnKey = (ctx: DeliveryContext) => `${ctx.session.id}\u0000${ctx.session.turn.id}`;

export function isTurnInterjectionDeliveryUntracked(ctx: DeliveryContext): boolean {
  return untrackedTurns.has(turnKey(ctx));
}

async function twice(ctx: DeliveryContext, stage: string, operation: () => Promise<unknown>): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await operation();
      return true;
    } catch (error) {
      console.error(JSON.stringify({
        attempt,
        code: "AGENT_TURN_INTERJECTION_DELIVERY_RECORD_FAILED",
        error: error instanceof Error ? error.message : String(error),
        eveSessionId: ctx.session.id,
        eveTurnId: ctx.session.turn.id,
        stage,
      }));
    }
  }
  return false;
}

export async function recordTurnInterjectionDelivery(
  ctx: DeliveryContext,
  stepIndex: number,
  repository: Repository = turnInterjectionRepository,
): Promise<void> {
  if (resolveTurnInterjectionScope(ctx) === null) return;
  const recorded = await twice(ctx, "step", () => repository.stepStarted(ctx.session.id, ctx.session.turn.id, stepIndex));
  if (recorded) untrackedTurns.delete(turnKey(ctx));
  else untrackedTurns.add(turnKey(ctx));
}

export async function finishTurnInterjectionDelivery(
  ctx: DeliveryContext,
  repository: Repository = turnInterjectionRepository,
): Promise<void> {
  if (resolveTurnInterjectionScope(ctx) === null) return;
  untrackedTurns.delete(turnKey(ctx));
  await twice(ctx, "turn", () => repository.finishTurn(ctx.session.id, ctx.session.turn.id));
}
