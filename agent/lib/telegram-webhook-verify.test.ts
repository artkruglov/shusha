/**
 * Telegram webhook verification order.
 *
 * Constructs covered:
 * - A request without the secret-token header, or with a wrong one, is refused before its body
 *   is read, so an unauthenticated caller cannot make the server buffer a large body.
 * - A request with the right secret returns its body.
 */
import { verifyTelegramRequest } from "eve/channels/telegram";
import { describe, expect, it } from "vitest";

const SECRET = "telegram-webhook-test-secret";

function requestWithCountedBody(headers: Record<string, string>): { request: Request; pulled: () => number } {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls > 4) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(pulls === 1 ? "{\"update_id\":1" : " "));
      if (pulls === 4) controller.enqueue(new TextEncoder().encode("}"));
    },
  });
  const request = new Request("https://example.test/eve/v1/telegram", {
    body,
    // @ts-expect-error -- Node needs half-duplex for a streamed request body.
    duplex: "half",
    headers,
    method: "POST",
  });
  return { pulled: () => pulls, request };
}

describe("verifyTelegramRequest", () => {
  it.each([
    ["no secret header", {}],
    ["a wrong secret", { "x-telegram-bot-api-secret-token": "not-the-secret-at-all-000000" }],
  ])("refuses %s before reading the body", async (_name, headers) => {
    const { pulled, request } = requestWithCountedBody(headers);
    await expect(verifyTelegramRequest(request, { secretToken: SECRET })).rejects.toThrow(/secret-token/u);
    expect(request.bodyUsed).toBe(false);
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  it("returns the body of a request with the right secret", async () => {
    const { request } = requestWithCountedBody({ "x-telegram-bot-api-secret-token": SECRET });
    await expect(verifyTelegramRequest(request, { secretToken: SECRET })).resolves.toMatch(/^\{"update_id":1 +\}$/u);
  });
});
