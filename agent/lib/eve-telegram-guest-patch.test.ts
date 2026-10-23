/**
 * Guest-mode seam of the local Eve Telegram patch (Bot API 10.0 `guest_message`).
 *
 * Constructs covered:
 * - `onGuestUpdate`: a verified `guest_message` reaches the application instead of Eve's silent drop.
 * - Other update kinds Eve cannot parse stay acknowledged and dropped.
 * - The guest hook never runs before webhook authentication.
 * - `onChatJoinRequest`: a verified `chat_join_request` reaches the application the same way.
 */
import { telegramChannel } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

interface HttpRoute {
  handler(request: Request, context: Record<string, unknown>): Promise<Response>;
}

const guestUpdate = {
  guest_message: {
    chat: { id: 501, type: "private" },
    date: 1_700_000_000,
    from: { first_name: "Артём", id: 101, is_bot: false },
    guest_query_id: "guest-1",
    message_id: 9,
    text: "@shusha_bot привет",
  },
  update_id: 2001,
};

function post(route: HttpRoute, body: unknown, secret = "webhook-secret") {
  return route.handler(new Request("https://agent.example/eve/v1/telegram", {
    body: JSON.stringify(body),
    headers: { "x-telegram-bot-api-secret-token": secret },
    method: "POST",
  }), { from: vi.fn(), params: {}, requestIp: null, waitUntil: vi.fn() });
}

describe("Eve Telegram guest update patch", () => {
  it("hands a verified guest message to the application hook with the raw body", async () => {
    const onGuestUpdate = vi.fn(async () => new Response("guest-ok"));
    const onVerifiedUpdate = vi.fn();
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      onGuestUpdate,
      onVerifiedUpdate,
    });

    const response = await post(channel.routes[0] as unknown as HttpRoute, guestUpdate);

    expect(await response.text()).toBe("guest-ok");
    expect(onVerifiedUpdate).not.toHaveBeenCalled();
    expect(onGuestUpdate).toHaveBeenCalledTimes(1);
    const [context] = onGuestUpdate.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(context.raw).toEqual(guestUpdate);
    expect(typeof context.dispatch).toBe("function");
    expect(typeof context.waitUntil).toBe("function");
  });

  it("keeps dropping update kinds that are neither parsed nor guest messages", async () => {
    const onGuestUpdate = vi.fn();
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      onGuestUpdate,
    });

    const response = await post(channel.routes[0] as unknown as HttpRoute, {
      inline_query: { from: { first_name: "А", id: 1, is_bot: false }, id: "q", offset: "", query: "x" },
      update_id: 2002,
    });

    expect(await response.text()).toBe("ok");
    expect(onGuestUpdate).not.toHaveBeenCalled();
  });

  it("never exposes a guest message before webhook authentication", async () => {
    const onGuestUpdate = vi.fn();
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      onGuestUpdate,
    });

    const response = await post(channel.routes[0] as unknown as HttpRoute, guestUpdate, "wrong-secret");

    expect(response.status).toBe(401);
    expect(onGuestUpdate).not.toHaveBeenCalled();
  });

  it("hands a verified chat join request to its own hook, and never before authentication", async () => {
    const onChatJoinRequest = vi.fn(async () => new Response("join-ok"));
    const onGuestUpdate = vi.fn();
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      onChatJoinRequest,
      onGuestUpdate,
    });
    const joinUpdate = {
      chat_join_request: { chat: { id: -1009, type: "supergroup" }, date: 1, from: { id: 600, is_bot: false }, user_chat_id: 600 },
      update_id: 2003,
    };

    expect((await post(channel.routes[0] as unknown as HttpRoute, joinUpdate, "wrong-secret")).status).toBe(401);
    expect(onChatJoinRequest).not.toHaveBeenCalled();
    const response = await post(channel.routes[0] as unknown as HttpRoute, joinUpdate);

    expect(await response.text()).toBe("join-ok");
    expect(onGuestUpdate).not.toHaveBeenCalled();
    const [context] = onChatJoinRequest.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(context.raw).toEqual(joinUpdate);
  });
});
