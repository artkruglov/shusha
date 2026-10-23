/**
 * Delivery record for messages shown to a running turn.
 *
 * Export:
 * - Eve stream hook: a starting model step carries every tool result returned during earlier steps;
 *   the end of the turn settles what its last step saw.
 */
import { defineHook } from "eve/hooks";

import {
  finishTurnInterjectionDelivery,
  recordTurnInterjectionDelivery,
} from "../lib/turn-interjection/turn-interjection-delivery.js";

export default defineHook({
  events: {
    "step.started": async (event, ctx) => await recordTurnInterjectionDelivery(ctx, event.data.stepIndex),
    "turn.completed": async (_event, ctx) => await finishTurnInterjectionDelivery(ctx),
    "turn.failed": async (_event, ctx) => await finishTurnInterjectionDelivery(ctx),
  },
});
