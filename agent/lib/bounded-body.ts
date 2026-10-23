/**
 * Reading an external response body with a hard byte cap.
 *
 * Export:
 * - `readBoundedBody`: the body as a Buffer, or the caller's error once it exceeds the cap.
 *
 * Key construct:
 * - Eight clients read provider, Telegram, GitHub and web bodies; each had its own loop, and only
 *   some checked Content-Length, released the reader or cancelled the stream. A declared length is
 *   checked first, then bytes are counted while streaming, so a missing or dishonest header cannot
 *   force unbounded buffering. A response without a body reads as empty; a caller that needs bytes
 *   checks `response.body` itself.
 */
/** The part of a fetch Response this reads; undici's own Response type satisfies it too. */
interface BodySource {
  readonly body: (AsyncIterable<Uint8Array> & { cancel(reason?: unknown): Promise<void> }) | null;
  readonly headers: { get(name: string): string | null };
}

export async function readBoundedBody(
  response: BodySource,
  maxBytes: number,
  tooLarge: () => Error,
): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Leaving the loop early (the throw below) cancels the stream through the iterator's return().
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}
