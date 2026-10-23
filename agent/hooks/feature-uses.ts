/**
 * Feature use signals for feature tips.
 *
 * Export:
 * - Eve hook recording which abilities a person tried, from the tools their trusted turn called.
 *
 * Key construct:
 * - Failures are logged, never thrown: a bookkeeping hook must not fail a Telegram turn.
 */
import { defineHook } from "eve/hooks";

import { featureUseRepository } from "../lib/feature-uses/feature-use-repository.js";
import { createFeatureUseHandlers } from "../lib/feature-uses/feature-use-signals.js";

const handlers = createFeatureUseHandlers({
  record: (input) => featureUseRepository.record(input),
});

export default defineHook({
  events: {
    async "actions.requested"(event, ctx) {
      try {
        await handlers.actionsRequested(event, ctx);
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_FEATURE_USE_RECORD_FAILED",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
  },
});
