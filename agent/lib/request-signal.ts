/**
 * Per-request deadlines for outbound HTTP.
 *
 * Exports:
 * - `deadlineSignal`: a fresh timeout joined with any caller signals that are present.
 * - `withRequestTimeout`: a fetch whose every request gets its own deadline, plus an optional outer
 *   cancellation and whatever signal the request itself carries.
 *
 * Key construct:
 * - Telegram, web, search and lab calls each joined a timeout with a caller signal by hand. Some
 *   shared one timeout across all requests of an adapter, some dropped the caller's signal. Here
 *   the deadline starts per request and no signal a caller passed is lost.
 */
export function deadlineSignal(timeoutMs: number, ...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const timeout = AbortSignal.timeout(timeoutMs);
  return present.length === 0 ? timeout : AbortSignal.any([...present, timeout]);
}

export function withRequestTimeout(
  fetchImplementation: typeof fetch,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): typeof fetch {
  return (request, init) => fetchImplementation(request, {
    ...init,
    signal: deadlineSignal(timeoutMs, outerSignal, init?.signal ?? undefined),
  });
}
