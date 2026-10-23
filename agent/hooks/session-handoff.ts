/**
 * Session handoff bookkeeping.
 *
 * Export:
 * - Eve hook: the turn that carries the handoff of a retired session marks it shown once Eve has
 *   started it, which is after the message was accepted durably.
 */
import { defineHook } from "eve/hooks";

import { markSessionHandoffShown } from "../lib/sessions/session-handoff-shown.js";

export default defineHook({
  events: {
    "turn.started": async (_event, ctx) => await markSessionHandoffShown(ctx),
  },
});
