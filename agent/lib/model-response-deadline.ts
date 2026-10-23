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
 *   ownership lease (860 s), which re-ran the step and lost its retry.
 * - Under load DeepSeek answers 200 at once and then only keeps the connection open: SSE comments
 *   (`: keep-alive`) on a stream, blank lines on a plain JSON answer. That is waiting, not answering, so
 *   neither the headers nor those bytes count. The start deadline (eight minutes from the request) runs
 *   until the first real payload: a byte of an SSE `data:` line, or a non-whitespace byte of any other
 *   body. After it the idle deadline (four minutes) restarts only on further payload bytes.
 * - These are deadlines on silence, not on the step: there is no overall cap. A stream that keeps
 *   sending real events, however slowly, is never cut and can still outlive the 860 s lease.
 * - The deadline aborts with an application error rather than an AbortError, so neither the AI SDK
 *   nor Eve mistakes it for the person cancelling the turn. Eve classifies it as recoverable and
 *   Workflow retries the step.
 * - Bytes pass through unchanged; only a small per-line state survives chunk boundaries.
 */
import { AppError } from "./app-error.js";

// Eight minutes, not Ilya's four: a non-streamed call (vision at high effort took up to four minutes on one photo) only
// gets its headers once the whole answer is ready, and eight is still well inside Workflow's 860 s ownership lease.
export const MODEL_RESPONSE_START_TIMEOUT_MS = 8 * 60 * 1000;
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

const DATA_FIELD = [0x64, 0x61, 0x74, 0x61, 0x3a]; // "data:"
const LF = 0x0a;
const CR = 0x0d;

/** Counts payload bytes: SSE `data:` lines for an event stream, non-whitespace for any other body. */
function createPayloadDetector(eventStream: boolean): (chunk: Uint8Array) => boolean {
  if (!eventStream) {
    return (chunk) => chunk.some((byte) => byte !== 0x20 && byte !== 0x09 && byte !== LF && byte !== CR);
  }
  // Line state across chunks: how much of "data:" the current line has matched, or whether the line
  // is already known to be a data line (true) or another field or comment (false).
  let matched = 0;
  let kind: boolean | null = null;
  return (chunk) => {
    let payload = false;
    for (const byte of chunk) {
      if (byte === LF || byte === CR) {
        // A bare "data" line is a data field with an empty value.
        if (kind === null && matched === 4) payload = true;
        matched = 0;
        kind = null;
      } else if (kind === true) {
        payload = true;
      } else if (kind === null) {
        if (byte !== DATA_FIELD[matched]) {
          kind = false;
        } else if (++matched === DATA_FIELD.length) {
          kind = true;
          payload = true;
        }
      }
    }
    return payload;
  };
}

export function withResponseDeadlines(
  fetchImplementation: Fetch,
  limits: { idleMs: number; startMs: number },
): Fetch {
  return async (input, init) => {
    const deadline = new AbortController();
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
    let stream: TransformStreamDefaultController<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const arm = (stage: "start" | "stream", ms: number) => {
      clear();
      timer = setTimeout(() => {
        const reason = responseTimeout(stage);
        deadline.abort(reason);
        // Error the watched body too, so the cut does not depend on the fetch honouring the signal.
        try {
          stream?.error(reason);
        } catch {
          // Already closed or errored.
        }
      }, ms);
    };
    signal.addEventListener("abort", clear, { once: true });

    arm("start", limits.startMs);
    let response: Response;
    try {
      response = await fetchImplementation(input, { ...init, signal });
    } catch (error) {
      clear();
      throw error;
    }
    if (!response.body) {
      clear();
      return response;
    }

    // The start deadline keeps running through keep-alive bytes; the first payload hands over to idle.
    const isPayload = createPayloadDetector(
      (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream"),
    );
    // `cancel` (the consumer dropped the body) is WHATWG and Node 24 calls it; TypeScript's lib lacks it.
    const transformer: Transformer<Uint8Array, Uint8Array> & { cancel(): void } = {
      start(controller) {
        stream = controller;
      },
      transform(chunk, controller) {
        if (isPayload(chunk)) arm("stream", limits.idleMs);
        controller.enqueue(chunk);
      },
      flush: clear,
      cancel: clear,
    };
    const watched = response.body.pipeThrough(new TransformStream(transformer));
    return new Response(watched, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}
