/**
 * Model transport retry observability tests.
 *
 * Constructs covered:
 * - AI SDK retries two provider-declared overload responses before succeeding.
 * - Every failed physical provider attempt emits one structured application log.
 * - A hanging provider fetch is cut by the response deadline on the primary call and on the
 *   `fallbackModelId` retry, so dropping the wrapper from either path fails here.
 */
import { generateText } from "ai";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MODEL_RESPONSE_START_TIMEOUT_MS } from "./model-response-deadline.js";
import { createConfiguredLanguageModel } from "./model-transport.js";

function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function retiredModelResponse(): Response {
  return new Response(JSON.stringify({ error: { message: "The supported API model names are deepseek-v4-pro, deepseek-v4-flash, but you passed deepseek-v4.1-flash-expires-on-0910.", type: "invalid_request_error" } }), {
    headers: { "content-type": "application/json" },
    status: 400,
  });
}

function deepSeekModel(fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return createConfiguredLanguageModel({
    apiKey: "model-secret",
    fetch,
    maxOutputTokens: 1_000,
    modelId: "deepseek-v4.1-flash-expires-on-0910",
    transport: {
      baseUrl: "https://api.deepseek.com",
      fallbackModelId: "deepseek-v4-flash",
      protocol: "deepseek-responses",
      reasoning: { effort: "low" },
    },
  });
}

const PROMPT = { prompt: [{ content: [{ text: "Проверка", type: "text" }], role: "user" }] } as LanguageModelV4CallOptions;

function overloadedResponse(): Response {
  return new Response(JSON.stringify({
    error: {
      message: "The server cluster is currently under high load. (2064)",
      type: "overloaded_error",
    },
    type: "error",
  }), {
    headers: { "content-type": "application/json" },
    status: 529,
  });
}

function successfulResponse(): Response {
  return new Response(JSON.stringify({
    content: [{ text: "Готово", type: "text" }],
    id: "msg_retry_001",
    model: "MiniMax-M3",
    role: "assistant",
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("model transport retry policy", () => {
  it("retries two overloaded responses and logs every failed physical attempt", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const responses = [overloadedResponse(), overloadedResponse(), successfulResponse()];
    const fetch = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected model request");
      return response;
    });
    const model = createConfiguredLanguageModel({
      apiKey: "model-secret",
      fetch,
      maxOutputTokens: 128_000,
      modelId: "MiniMax-M3",
      transport: {
        authentication: "bearer",
        // The mock accepts this deliberately malformed provider URL so the log must redact its query.
        baseUrl: "https://api.minimax.io/anthropic/v1?api_key=provider-secret",
        protocol: "anthropic-messages",
        reasoning: { mode: "adaptive", type: "enabled" },
      },
    });

    const result = generateText({ maxRetries: 2, model, prompt: "Проверка" });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ text: "Готово" });
    expect(fetch).toHaveBeenCalledTimes(3);
    const transientLog = JSON.stringify({
      code: "AGENT_MODEL_TRANSIENT_RESPONSE",
      modelId: "MiniMax-M3",
      statusCode: 529,
      url: "https://api.minimax.io/anthropic/v1",
    });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(1, transientLog);
    expect(log).toHaveBeenNthCalledWith(2, transientLog);
  });

  it("cuts a hanging primary call at the start deadline", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => await hang(init?.signal));
    const result = deepSeekModel(fetch).doGenerate(PROMPT);
    const settled = expect(result).rejects.toMatchObject({ code: "AGENT_MODEL_RESPONSE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(MODEL_RESPONSE_START_TIMEOUT_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
  });

  it("cuts a hanging fallback-model retry at the start deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const models: string[] = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      models.push((JSON.parse(String(init?.body)) as { model: string }).model);
      return models.length === 1 ? retiredModelResponse() : await hang(init?.signal);
    });
    const result = deepSeekModel(fetch).doGenerate(PROMPT);
    const settled = expect(result).rejects.toMatchObject({ code: "AGENT_MODEL_RESPONSE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(MODEL_RESPONSE_START_TIMEOUT_MS);
    await settled;
    expect(models).toEqual(["deepseek-v4.1-flash-expires-on-0910", "deepseek-v4-flash"]);
  });
});
