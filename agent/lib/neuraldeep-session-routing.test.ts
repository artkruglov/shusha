/**
 * Per-step model selection options.
 *
 * Constructs covered:
 * - NeuralDeep gets its sticky session routing; other providers get no options of their own.
 * - The chat of a group without a family travels to the transport alongside any provider option.
 */
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";

import { familylessGroupFromAuth } from "./familyless-group-auth.js";
import { resolveSessionModelSelection } from "./neuraldeep-session-routing.js";

const model = "test-model" as unknown as LanguageModel;
const base = { model, modelContextWindowTokens: 100, sessionId: "session-1" };

describe("session model selection", () => {
  it("adds only what the provider and the turn need", () => {
    expect(resolveSessionModelSelection({ ...base, providerId: "deepseek" })).toEqual({ model, modelContextWindowTokens: 100 });
    expect(resolveSessionModelSelection({ ...base, providerId: "neuraldeep" }).modelOptions)
      .toEqual({ providerOptions: { neuraldeep: { user: "session-1" } } });
    expect(resolveSessionModelSelection({ ...base, providerId: "neuraldeep", usageChatId: "-1001" }).modelOptions)
      .toEqual({ providerOptions: { neuraldeep: { user: "session-1" }, osinara: { usageChatId: "-1001" } } });
    expect(resolveSessionModelSelection({ ...base, providerId: "deepseek", usageFamilyId: "0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a" }).modelOptions)
      .toEqual({ providerOptions: { osinara: { usageFamilyId: "0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a" } } });
  });

  it("names a chat only for a verified turn of a group without a family", () => {
    const groupId = "6f1c2f9e-3b1a-4c55-9d8e-0a1b2c3d4e5f";
    const familyless = { groupId, groupType: "external", telegramChatId: "-1001" };
    expect(familylessGroupFromAuth(familyless)).toEqual({ groupId, telegramChatId: "-1001" });
    expect(familylessGroupFromAuth({ ...familyless, familyId: "family-1" })).toBeNull();
    expect(familylessGroupFromAuth({ ...familyless, familyId: null })).toBeNull();
    expect(familylessGroupFromAuth({ ...familyless, groupType: "family_private" })).toBeNull();
    expect(familylessGroupFromAuth({ ...familyless, telegramChatId: "chat" })).toBeNull();
  });
});
