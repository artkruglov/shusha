/**
 * Eve event handler behind feature tips: which abilities a person tried, from the tools their turn called.
 *
 * Exports:
 * - `createFeatureUseHandlers`: `actions.requested` maps tool calls to feature keys (`feature-catalog.ts`) and
 *   records each key once per turn for the person who started the turn.
 * - `featureUseActor`: the person and family of a trusted turn, or null.
 *
 * Key constructs:
 * - Only a person's own private chat with the bot and a family group count: an external group, a subagent, a
 *   scheduled run and the silent memory review are not the person trying anything.
 * - The actor comes from the verified session auth (principal and family attributes), never from tool input.
 * - Failures are the caller's to log; the hook never fails a Telegram turn.
 */
import type { SessionAuth } from "eve/context";

import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import { isMemoryReviewSession } from "../memory-review/memory-review-session.js";
import { featureOfTool, type FeatureKey } from "./feature-catalog.js";

interface FeatureUseContext {
  channel: { kind?: string };
  session: { auth: SessionAuth; id: string };
}

interface FeatureUseAction {
  readonly [key: string]: unknown;
  kind: string;
  toolName?: string;
}

export interface FeatureUseDependencies {
  record(input: { familyId: string; features: readonly FeatureKey[]; now: Date; userId: string }): Promise<void>;
}

const MAX_TRACKED_TURNS = 200;

export function featureUseActor(ctx: FeatureUseContext): { familyId: string; userId: string } | null {
  if (ctx.channel.kind === "subagent" || isMemoryReviewSession(ctx) || isScheduledSession(ctx)) return null;
  const current = ctx.session.auth.current;
  const attributes = current?.attributes;
  if (current?.authenticator !== "telegram" || !attributes) return null;
  const trusted = attributes.telegramChatType === "private" || attributes.groupType === "family_private";
  const familyId = attributes.familyId;
  const userId = current.principalId;
  if (!trusted || typeof familyId !== "string" || typeof userId !== "string") return null;
  // Another bot in a group carries a service principal, not a person.
  if (userId.startsWith("telegram-bot:")) return null;
  return { familyId, userId };
}

export function createFeatureUseHandlers(dependencies: FeatureUseDependencies) {
  /** Keys already recorded in a turn: a turn of ten searches is one use of search. */
  const recorded = new Map<string, Set<FeatureKey>>();

  function fresh(key: string, features: readonly FeatureKey[]): FeatureKey[] {
    const seen = recorded.get(key) ?? new Set<FeatureKey>();
    const novel = features.filter((feature) => !seen.has(feature));
    for (const feature of novel) seen.add(feature);
    recorded.delete(key);
    recorded.set(key, seen);
    while (recorded.size > MAX_TRACKED_TURNS) {
      const oldest = recorded.keys().next().value;
      if (oldest === undefined) break;
      recorded.delete(oldest);
    }
    return novel;
  }

  return {
    async actionsRequested(
      event: { data: { actions: readonly FeatureUseAction[]; turnId: string } },
      ctx: FeatureUseContext,
      now = new Date(),
    ): Promise<void> {
      const actor = featureUseActor(ctx);
      if (!actor) return;
      const features = [...new Set(event.data.actions.flatMap((action) => {
        if (action.kind !== "tool-call" || typeof action.toolName !== "string") return [];
        const feature = featureOfTool(action.toolName);
        return feature ? [feature] : [];
      }))];
      if (features.length === 0) return;
      const novel = fresh(`${ctx.session.id}:${event.data.turnId}`, features);
      if (novel.length === 0) return;
      await dependencies.record({ familyId: actor.familyId, features: novel, now, userId: actor.userId });
    },
  };
}
