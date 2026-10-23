/**
 * Explicit AI SDK model registry.
 *
 * Exports:
 * - `primaryModel`: configured protocol-native text model for the Eve agent loop.
 * - `visionModel`: independently selected model, or `null` when image input is unsupported.
 * - `sessionHandoffModel`: the primary model without reasoning for the summary a rotating session
 *   hands to its successor.
 * - `voiceTranscriptionModel`: isolated Groq Whisper route for Telegram voice notes.
 */
import { createGroq } from "@ai-sdk/groq";

import { modelProviderConfig } from "./model-provider-config.js";
import type { ModelProviderConfig } from "./model-provider-config-schema.js";
import { recordModelUsage } from "./health/model-usage-repository.js";
import { createConfiguredLanguageModel } from "./model-transport.js";

const agentModelApiKey = process.env.MODEL_API_KEY as string;
const groqApiKey = process.env.GROQ_API_KEY;

export const primaryModel = createConfiguredLanguageModel({
  apiKey: agentModelApiKey,
  maxOutputTokens: modelProviderConfig.agent.models.primary.maxOutputTokens,
  onUsage: recordModelUsage,
  modelId: modelProviderConfig.agent.models.primary.id,
  transport: modelProviderConfig.agent.transport,
});
/** Search uses DeepSeek's live-supported Anthropic API independently of the main transport. */
export const errandResearchModel = createConfiguredLanguageModel({
  apiKey: agentModelApiKey,
  maxOutputTokens: 8192,
  onUsage: recordModelUsage,
  modelId: modelProviderConfig.agent.models.primary.id,
  transport: modelProviderConfig.provider === "deepseek"
    ? {protocol:"anthropic-messages",baseUrl:"https://api.deepseek.com/anthropic/v1",
        authentication:"api-key",reasoning:{type:"none"}}
    : modelProviderConfig.agent.transport,
});
const visionConfig = modelProviderConfig.agent.models.vision;

type ReasoningEffort = "none" | "low" | "high" | "max";

/**
 * The primary transport at another reasoning effort where the protocol has such a control. The
 * Anthropic Messages transport knows only on and off (`thinking: adaptive` against `disabled`,
 * `model-transport.ts`), so any effort but "none" keeps the configured mode.
 */
export function withReasoningEffort(
  transport: ModelProviderConfig["agent"]["transport"],
  effort: ReasoningEffort,
): ModelProviderConfig["agent"]["transport"] {
  if (transport.protocol === "anthropic-messages") {
    return effort === "none" && transport.reasoning?.type !== "none"
      ? { ...transport, reasoning: { type: "none" } }
      : transport;
  }
  if (transport.protocol === "deepseek-responses") return { ...transport, reasoning: { effort } };
  if (transport.protocol === "openai-chat-completions" && transport.reasoning !== null) {
    return {
      ...transport,
      reasoning: effort === "none"
        ? { format: transport.reasoning.format, type: "none" }
        : { effort, format: transport.reasoning.format, type: "effort" },
    };
  }
  return transport;
}

/**
 * The session handoff summary: a person waits for it once per fifty turns. Measured upstream on a
 * 76-entry chat (15 October 2026): without reasoning 3.7 s and the same three sections as with low
 * effort at 8.4 s, where a thousand reasoning tokens bought nothing visible. Usage is recorded like
 * the primary model's: the summary spends the family's budget too.
 */
export const sessionHandoffModel = createConfiguredLanguageModel({
  apiKey: agentModelApiKey,
  maxOutputTokens: modelProviderConfig.agent.models.primary.maxOutputTokens,
  onUsage: recordModelUsage,
  modelId: modelProviderConfig.agent.models.primary.id,
  transport: withReasoningEffort(modelProviderConfig.agent.transport, "none"),
});

/** The shared transport with the vision model's own reasoning effort where the protocol has one. */
export function visionTransport(
  transport: ModelProviderConfig["agent"]["transport"],
  vision: ModelProviderConfig["agent"]["models"]["vision"],
): ModelProviderConfig["agent"]["transport"] {
  if (!vision.supportsImageInput || vision.reasoningEffort === undefined) return transport;
  if (transport.protocol !== "deepseek-responses") return transport;
  return { ...transport, reasoning: { effort: vision.reasoningEffort } };
}

export const visionModel = visionConfig.supportsImageInput
  ? createConfiguredLanguageModel({
      apiKey: agentModelApiKey,
      maxOutputTokens: visionConfig.maxOutputTokens,
      onUsage: recordModelUsage,
      modelId: visionConfig.id,
      transport: visionTransport(modelProviderConfig.agent.transport, visionConfig),
    })
  : null;

// Voice is an explicit optional capability and never falls back to the agent transport.
export const voiceTranscriptionModel = modelProviderConfig.voice.enabled && modelProviderConfig.voice.provider !== "gigaam" && groqApiKey
  ? createGroq({ apiKey: groqApiKey }).transcription(
      modelProviderConfig.voice.transcriptionModelId,
    )
  : null;
