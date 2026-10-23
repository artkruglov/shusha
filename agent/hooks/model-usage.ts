/**
 * Per-step model usage audit log.
 *
 * Export:
 * - Eve hook that logs framework-reported usage of every completed model step with session identity
 *   and how long the step took, plus `AGENT_TURN_TIMING` markers at turn and step start.
 *
 * Key constructs:
 * - Provider cache fields are logged separately at the transport boundary (`AGENT_MODEL_USAGE`);
 *   this hook adds the session, turn, and step so both logs can be correlated by order and time.
 * - A step's duration runs from `step.started` to `step.completed`; a compaction between the two
 *   events of one turn gets its own duration on `AGENT_COMPACTION_COMPLETED`.
 */
import { defineHook } from "eve/hooks";

import { createStepClock, formatCompactionLog, formatStepUsageLog } from "../lib/model-usage-log.js";
import { logTurnTiming } from "../lib/turn-timing.js";

const clock = createStepClock();
const stepKey = (sessionId: string, turnId: string, stepIndex: number) => `${sessionId}/${turnId}/${stepIndex}`;
const compactionKey = (sessionId: string, turnId: string) => `compaction/${sessionId}/${turnId}`;

export default defineHook({
  events: {
    // Wall-clock markers between the prepared inbound context and the first model request.
    "turn.started"(event, ctx) {
      logTurnTiming("turn_started", 0, {
        channelKind: ctx.channel.kind,
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
      });
    },
    "step.started"(event, ctx) {
      clock.start(stepKey(ctx.session.id, event.data.turnId, event.data.stepIndex));
      logTurnTiming("step_started", 0, {
        sessionId: ctx.session.id,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      });
    },
    "compaction.requested"(event) {
      clock.start(compactionKey(event.data.sessionId, event.data.turnId));
      console.info(formatCompactionLog(event));
    },
    "compaction.completed"(event) {
      console.info(formatCompactionLog(event, clock.finish(compactionKey(event.data.sessionId, event.data.turnId))));
    },
    "step.completed"(event, ctx) {
      const familyId = ctx.session.auth.current?.attributes?.familyId;
      console.info(formatStepUsageLog(event, {
        channelKind: ctx.channel.kind,
        ...(typeof familyId === "string" ? { familyId } : {}),
        sessionId: ctx.session.id,
      }, clock.finish(stepKey(ctx.session.id, event.data.turnId, event.data.stepIndex))));
    },
  },
});
