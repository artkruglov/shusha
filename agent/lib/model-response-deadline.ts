/**
 * Deadlines on waiting for the model, not on answering.
 *
 * Exports:
 * - `MODEL_RESPONSE_START_TIMEOUT_MS`, `MODEL_STREAM_IDLE_TIMEOUT_MS`: production limits.
 * - `withResponseDeadlines`: a fetch that fails with `AGENT_MODEL_RESPONSE_TIMEOUT` when the provider
 *   does not start answering in time or a streamed answer stops sending.
 *
 * Key construct:
 * - On 1 October 2026 DeepSeek held requests for up to 900 s («unable to start processing within the
 *   900-second timeout»). A model step that long outlived the queue's call and Workflow's inline
 *   ownership lease (860 s), which re-ran the step and lost its retry. A stalled call now fails
 *   after four minutes, well inside both; Eve classifies the error as recoverable and Workflow
 *   retries the step. A long answer that keeps streaming is never cut: only silence is.
 * - The deadline aborts with an application error rather than an AbortError, so neither the AI SDK
 *   nor Eve mistakes it for the person cancelling the turn.
 */
import { AppError } from "./app-error.js";

export const MODEL_RESPONSE_START_TIMEOUT_MS = 4 * 60 * 1000;
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 4 * 60 * 1000;

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function responseTimeout(stage: "start" | "stream"): AppError {
  return new AppError(
    "AGENT_MODEL_RESPONSE_TIMEOUT",
    stage === "start"
      ? "Модель не начала отвечать вовремя. Повторите запрос позже"
      : "Модель перестала присылать ответ. Повторите запрос позже",
  );
}

export function withResponseDeadlines(
  fetchImplementation: Fetch,
  limits: { idleMs: number; startMs: number },
): Fetch {
  return async (input, init) => {
    const deadline = new AbortController();
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
    const startTimer = setTimeout(() => deadline.abort(responseTimeout("start")), limits.startMs);
    let response: Response;
    try {
      response = await fetchImplementation(input, { ...init, signal });
    } finally {
      clearTimeout(startTimer);
    }
    if (!response.body) return response;

    // Each chunk restarts the idle timer; silence aborts the request, which errors the body.
    let idleTimer = setTimeout(() => deadline.abort(responseTimeout("stream")), limits.idleMs);
    const watched = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => deadline.abort(responseTimeout("stream")), limits.idleMs);
        controller.enqueue(chunk);
      },
      flush() {
        clearTimeout(idleTimer);
      },
    }));
    signal.addEventListener("abort", () => clearTimeout(idleTimer), { once: true });
    return new Response(watched, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}
