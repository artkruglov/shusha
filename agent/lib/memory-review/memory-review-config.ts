/**
 * Stable memory-review runtime configuration.
 *
 * Exports:
 * - Batch size, dispatch/alert leases, bounded recovery, stale/abandoned bounds, claim bounds.
 * - In-flight and materialization caps of the minute dispatcher, tunable per installation.
 */
import { integerSetting } from "../runtime-tuning.js";

/**
 * A running batch waits only for its own turn to report back. This bound is the last resort for a
 * turn that never does, so it must stay far above any real turn, including one that survives a
 * restart. Provenance, not this clock, decides what happens to the batch when it expires.
 */
export const MEMORY_REVIEW_ABANDONED_TURN_BATCH_SIZE = 10;
export const MEMORY_REVIEW_ABANDONED_TURN_TIMEOUT_MILLISECONDS = 60 * 60 * 1_000;
export const MEMORY_REVIEW_BATCH_SIZE = 50;
export const MEMORY_REVIEW_DISPATCH_BATCH_SIZE = 10;
// Reviews share the Workflow workers with the turns people wait for: at most this many background
// reviews run at once, and a claim takes only what the cap leaves. On one core a review in flight
// also takes the core from a live turn, so the cap is tunable: a single-family installation wants
// one or two, many families the default (port of ilkruglov 3e69a02c, 5e7604c2).
export const MEMORY_REVIEW_MAX_IN_FLIGHT = integerSetting(
  "MEMORY_REVIEW_MAX_IN_FLIGHT",
  { absent: 10, min: 1, max: 100 },
);
// Lanes materialized per minute pass, so one transaction never spans every lane of a large
// installation; lanes left over qualify again on the next pass.
export const MEMORY_REVIEW_MATERIALIZE_LANE_LIMIT = integerSetting(
  "MEMORY_REVIEW_MATERIALIZE_LANE_LIMIT",
  { absent: 200, min: 1, max: 10_000 },
);
// Idle review: a lane is reviewed once ten sources accumulate, after ten minutes of silence with
// at least five sources, or after six hours of silence with anything at all. One or two messages
// on their own gave the model nothing to judge: production reviewed 607 messages in 108 batches
// (80 of them with one or two sources) and kept nine records.
export const MEMORY_REVIEW_IDLE_MILLISECONDS = 10 * 60 * 1_000;
export const MEMORY_REVIEW_IDLE_MIN_SOURCES = 10;
export const MEMORY_REVIEW_IDLE_MIN_BATCH_SOURCES = 5;
export const MEMORY_REVIEW_LONG_IDLE_MILLISECONDS = 6 * 60 * 60 * 1_000;
// A group tail shorter than this stays for idle review instead of riding the addressed turn.
export const MEMORY_REVIEW_INTERACTIVE_MIN_SOURCES = 8;
// Existing claims shown to the review so it versions slots instead of duplicating.
export const MEMORY_REVIEW_CONTEXT_LIMIT = 40;
// Already processed messages shown before a background batch so the tail reads in context.
export const MEMORY_REVIEW_PRECEDING_CONTEXT_LIMIT = 20;
export const MEMORY_REVIEW_DISPATCH_LEASE_MILLISECONDS = 15 * 60 * 1_000;
export const MEMORY_REVIEW_INTERACTIVE_START_TIMEOUT_MILLISECONDS = 15 * 60 * 1_000;
export const MEMORY_REVIEW_MAX_SAFE_RECOVERY_ATTEMPTS = 1;
export const MEMORY_REVIEW_OWNER_ALERT_BATCH_SIZE = 10;
export const MEMORY_REVIEW_OWNER_ALERT_LEASE_MILLISECONDS = 15 * 60 * 1_000;
