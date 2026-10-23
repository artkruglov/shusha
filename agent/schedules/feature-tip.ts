/**
 * Eve ten-minute tick for the feature tip («фишка»): one untried ability, at most twice a week.
 *
 * Export:
 * - Default schedule; the dispatcher decides whose Tuesday or Friday afternoon it is and what to offer.
 *
 * The same tick then sends the first-steps quest touches (days 1, 3 and 7 after joining,
 * `onboarding-quest/quest-touch-dispatch.ts`). They share the daily `feature_tip` claim, so a person gets
 * either a tip or a touch on one local day; running them one after the other keeps the claim uncontested.
 *
 * The minute is offset from the other initiative ticks so they do not read the same tables at once.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchFeatureTips } from "../lib/initiative/feature-tip-runner.js";
import { dispatchQuestTouches } from "../lib/onboarding-quest/quest-touch-runner.js";

function failed(code: string) {
  return (error: unknown) => {
    console.error(JSON.stringify({ code, errorMessage: error instanceof Error ? error.message : String(error) }));
    throw error;
  };
}

export default defineSchedule({
  cron: "1-59/10 * * * *",
  run({ waitUntil }) {
    waitUntil(dispatchFeatureTips().catch(failed("AGENT_FEATURE_TIP_SCHEDULE_FAILED"))
      .finally(() => dispatchQuestTouches().catch(failed("AGENT_ONBOARDING_QUEST_SCHEDULE_FAILED"))));
  },
});
