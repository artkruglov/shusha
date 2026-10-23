/**
 * Guest messages (Bot API 10.0) and group join requests at the durable Telegram ingress.
 *
 * Constructs covered:
 * - A verified guest message is persisted before the webhook ACK, in a queue of its own query.
 * - The drain answers it through the application handler under a dispatch marker, never through Eve.
 * - A failed answer fails the update without a retry and without an Eve dispatch.
 * - A join request is persisted before the ACK in its group's own queue and greeted the same way, outside Eve.
 */
import { describe, expect, it, vi } from "vitest";

import type { TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";

type GuestHandler = (message: Record<string, unknown>, updateId: string) => Promise<void>;

const guestRaw = {
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

const joinRaw = {
  chat_join_request: {
    chat: { id: -1009, type: "supergroup" }, date: 1, from: { first_name: "Ирина", id: 600, is_bot: false },
    user_chat_id: 600,
  },
  update_id: 2001,
};

function repository(payload: Record<string, unknown> = guestRaw, key = "telegram:guest:guest-1") {
  const claim = {
    attemptCount: 1,
    deliveryContinuationKey: key,
    ingressContinuationKey: key,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    leaseToken: "123e4567-e89b-42d3-a456-426614174000",
    payload,
    queueId: "123e4567-e89b-42d3-a456-426614174001",
    transcript: null,
    updateId: "2001",
    voice: null,
  };
  return {
    claim,
    value: {
      acceptMedia: vi.fn().mockResolvedValue(true),
      beginDispatch: vi.fn(),
      beginVoiceTranscription: vi.fn().mockResolvedValue("started"),
      claimFollowing: vi.fn().mockResolvedValue([]),
      claimNext: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
      complete: vi.fn(),
      completeWithSession: vi.fn(),
      enqueue: vi.fn().mockResolvedValue("inserted"),
      fail: vi.fn(),
      hasPendingApprovals: vi.fn().mockResolvedValue(false),
      hasPendingApprovalsInChat: vi.fn().mockResolvedValue(false),
      listPendingAfter: vi.fn().mockResolvedValue([]),
      rekeyQueue: vi.fn(),
      release: vi.fn(),
      releaseStaleLeases: vi.fn().mockResolvedValue(0),
      renewLease: vi.fn(),
      sessionEventStreamCursor: vi.fn().mockResolvedValue(0),
      saveVoiceTranscript: vi.fn(),
    } satisfies TelegramIngressRepository,
  };
}

function ingress(storage: ReturnType<typeof repository>, handleGuestMessage: GuestHandler,
  handleChatJoinRequest?: (raw: Record<string, unknown>) => Promise<void>) {
  return createTelegramDurableIngress({
    acceptMedia: vi.fn().mockResolvedValue(true),
    authorizeVoice: vi.fn().mockResolvedValue(true),
    botUsername: "shusha_bot",
    ...(handleChatJoinRequest ? { handleChatJoinRequest } : {}),
    handleGuestMessage,
    handleGuestReminderCallback: vi.fn().mockResolvedValue(false),
    handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
    leaseMilliseconds: 60_000,
    repository: storage.value,
    requestSessionRotation: vi.fn(),
    transcribeVoice: vi.fn(),
  });
}

async function runGuest(storage: ReturnType<typeof repository>, handleGuestMessage: GuestHandler) {
  const dispatch = vi.fn();
  const tasks: Promise<unknown>[] = [];
  const response = await ingress(storage, handleGuestMessage).guest({
    dispatch,
    raw: guestRaw,
    waitUntil: (task) => tasks.push(task),
  });
  const settled = await Promise.allSettled(tasks);
  return { dispatch, response, settled };
}

describe("guest messages at the durable ingress", () => {
  it("persists the guest message in its own queue and answers it outside Eve", async () => {
    const storage = repository();
    const handleGuestMessage = vi.fn<GuestHandler>().mockResolvedValue(undefined);

    const { dispatch, response } = await runGuest(storage, handleGuestMessage);

    expect(await response.text()).toBe("ok");
    expect(storage.value.enqueue).toHaveBeenCalledWith({
      continuationKey: "telegram:guest:guest-1",
      payload: guestRaw,
      updateId: "2001",
    });
    expect(storage.value.beginDispatch).toHaveBeenCalledWith("2001", storage.claim.leaseToken);
    expect(handleGuestMessage).toHaveBeenCalledWith(guestRaw.guest_message, "2001");
    expect(storage.value.beginDispatch.mock.invocationCallOrder[0]!)
      .toBeLessThan(handleGuestMessage.mock.invocationCallOrder[0]!);
    expect(storage.value.complete).toHaveBeenCalledWith("2001", storage.claim.leaseToken);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails a guest message whose answer failed, without an Eve dispatch", async () => {
    const storage = repository();
    const handleGuestMessage = vi.fn<GuestHandler>().mockRejectedValue(new Error("network"));

    const { dispatch } = await runGuest(storage, handleGuestMessage);

    expect(storage.value.fail).toHaveBeenCalledWith("2001", storage.claim.leaseToken, expect.objectContaining({
      code: "AGENT_TELEGRAM_INGRESS_FAILED",
    }));
    expect(storage.value.complete).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("group join requests at the durable ingress", () => {
  it("persists the request in its group's queue and greets outside Eve under the dispatch marker", async () => {
    const storage = repository(joinRaw, "telegram:join:-1009");
    const greet = vi.fn(async (_raw: Record<string, unknown>) => undefined);
    const dispatch = vi.fn();
    const tasks: Promise<unknown>[] = [];
    const response = await ingress(storage, vi.fn<GuestHandler>(), greet).joinRequest({
      dispatch, raw: joinRaw, waitUntil: (task) => tasks.push(task),
    });
    await Promise.allSettled(tasks);

    expect(await response.text()).toBe("ok");
    expect(storage.value.enqueue).toHaveBeenCalledWith({ continuationKey: "telegram:join:-1009", payload: joinRaw, updateId: "2001" });
    expect(greet).toHaveBeenCalledWith(joinRaw);
    expect(storage.value.beginDispatch.mock.invocationCallOrder[0]!).toBeLessThan(greet.mock.invocationCallOrder[0]!);
    expect(storage.value.complete).toHaveBeenCalledWith("2001", storage.claim.leaseToken);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
