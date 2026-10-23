/** Installed by the version-pinned Workflow patch; no application data or auth enters this layer. */
import { createHash, timingSafeEqual } from "node:crypto";
import { Agent, fetch } from "undici";
import { WorkflowInvokePayloadSchema, type Queue } from "@workflow/world";

// Longer than the sandbox runner's 30-minute command window, without changing external model
// timeouts. Node's default fetch gives up on response headers after 300 s, while a flow request
// answers only when its inline turn step finishes: a longer turn failed the queue job, and Graphile
// redelivered it while the first execution was still running. A transport deadline never proves the
// executor died, so the execution fence below remains required.
export const WORKFLOW_HTTP_TIMEOUT_MS = 35 * 60 * 1000;
type Handler = Parameters<Queue["createQueueHandler"]>[1];
type Result = Awaited<ReturnType<Handler>>;
type FetchOptions = NonNullable<Parameters<typeof fetch>[1]>;

export function createWorkflowHttpClient(timeoutMilliseconds: number = WORKFLOW_HTTP_TIMEOUT_MS) {
  const dispatcher = new Agent({ headersTimeout: timeoutMilliseconds, bodyTimeout: timeoutMilliseconds });
  return {
    async fetch(url: string, options: FetchOptions) {
      try {
        return await fetch(url, { ...options, dispatcher });
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        console.error(JSON.stringify({
          code: "AGENT_WORKFLOW_TRANSPORT_FAILED",
          errorName: error instanceof Error ? error.name : "UnknownError",
          causeCode: cause && typeof cause === "object" && "code" in cause ? cause.code : null,
        }));
        throw error;
      }
    },
    close: () => dispatcher.close(),
  };
}

// The flow route lives on the agent's own listener and is reachable from the app network; the official
// handler checks header shape but no secret (ilkruglov 3c339144, security audit 6 October 2026). The queue
// sends the agent's internal token and the handler refuses anything else before the official one reads a byte.
export const WORKFLOW_INTERNAL_TOKEN_HEADER = "x-osinara-internal-token";

export function requireWorkflowInternalToken(): string {
  const token = process.env.AGENT_INTERNAL_TOKEN;
  if (!token) throw new Error("AGENT_INTERNAL_TOKEN_MISSING: Не задан внутренний токен для маршрута очереди");
  return token;
}

export function withWorkflowInternalToken(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const expected = Buffer.from(requireWorkflowInternalToken());
    const presented = Buffer.from(request.headers.get(WORKFLOW_INTERNAL_TOKEN_HEADER) ?? "");
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      return new Response(null, { status: 401 });
    }
    return handler(request);
  };
}

// Receiving side of the same process. A redelivery of a live message (same queue, message id and
// bytes) joins the running execution instead of starting a second one. Distinct deliveries of one
// explicit step serialize; workflow replays without a step id are never queued behind a running
// inline step, so a cancellation or hook replay still reaches it (upstream nyxandro 795ae11).
export function createWorkflowExecutionFence(isClosing: () => boolean = () => false): (handler: Handler) => Handler {
  const deliveries = new Map<string, { digest: string; execution: Promise<Result> }>();
  const stepTails = new Map<string, Promise<Result>>();
  return (handler) => async (message, meta) => {
    const deliveryKey = `${meta.queueName}:${meta.messageId}`;
    const bytes = JSON.stringify(message);
    if (bytes === undefined) throw new Error("AGENT_WORKFLOW_PAYLOAD_INVALID: Queue delivery has no serialized input");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const existing = deliveries.get(deliveryKey);
    if (existing) {
      if (existing.digest !== digest) throw new Error("AGENT_WORKFLOW_DELIVERY_CONFLICT: Live delivery ID has different input bytes");
      console.warn(JSON.stringify({ code: "AGENT_WORKFLOW_EXECUTION_JOINED", messageId: meta.messageId, attempt: meta.attempt }));
      return existing.execution;
    }
    const invocation = WorkflowInvokePayloadSchema.safeParse(message);
    const tailKey = invocation.success && invocation.data.stepId
      ? JSON.stringify([invocation.data.runId, invocation.data.stepId])
      : deliveryKey;
    const previous = stepTails.get(tailKey);
    const execute = () => {
      if (isClosing()) throw new Error("AGENT_WORKFLOW_SHUTTING_DOWN: Delivery did not start before shutdown");
      return handler(message, meta);
    };
    // Each caller keeps its own failure; ordering continues after a rejected predecessor.
    const execution = previous ? previous.then(execute, execute) : Promise.resolve().then(execute);
    const entry = { digest, execution };
    deliveries.set(deliveryKey, entry);
    stepTails.set(tailKey, execution);
    try {
      return await execution;
    } finally {
      if (deliveries.get(deliveryKey) === entry) deliveries.delete(deliveryKey);
      if (stepTails.get(tailKey) === execution) stepTails.delete(tailKey);
    }
  };
}
