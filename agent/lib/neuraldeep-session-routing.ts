/**
 * NeuralDeep session-sticky model routing.
 *
 * Exports:
 * - `resolveSessionModelSelection`: binds NeuralDeep requests to one upstream by Eve session ID and
 *   names the chat of a group without a family, or the family, whose monthly budget pays for the call.
 */
import type { AgentModelOptionsDefinition } from "eve";
import type { LanguageModel } from "ai";

import type { ModelProviderId } from "./model-provider-config.js";

interface SessionModelSelectionInput {
  readonly model: LanguageModel;
  readonly modelContextWindowTokens: number;
  readonly providerId: ModelProviderId;
  readonly sessionId: string;
  /** Telegram chat of a group without a family (migration 177); the transport records it, never sends it. */
  readonly usageChatId?: string | null;
  /** The family of a family turn (migration 181); recorded the same way, never sent. */
  readonly usageFamilyId?: string | null;
}

interface SessionModelSelection {
  readonly model: LanguageModel;
  readonly modelContextWindowTokens: number;
  readonly modelOptions?: AgentModelOptionsDefinition;
}

export function resolveSessionModelSelection({
  model,
  modelContextWindowTokens,
  providerId,
  sessionId,
  usageChatId = null,
  usageFamilyId = null,
}: SessionModelSelectionInput): SessionModelSelection {
  const usage = {
    ...(usageChatId === null ? {} : { usageChatId }),
    ...(usageFamilyId === null ? {} : { usageFamilyId }),
  };
  const providerOptions: Record<string, { [key: string]: string }> = {
    // NeuralDeep uses this OpenAI-compatible field for sticky upstream routing and KV-cache reuse.
    ...(providerId === "neuraldeep" ? { neuraldeep: { user: sessionId } } : {}),
    ...(Object.keys(usage).length === 0 ? {} : { osinara: usage }),
  };
  if (Object.keys(providerOptions).length === 0) return { model, modelContextWindowTokens };
  return { model, modelContextWindowTokens, modelOptions: { providerOptions } };
}
