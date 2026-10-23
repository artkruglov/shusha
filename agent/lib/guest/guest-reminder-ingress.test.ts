/**
 * «Напомнить и мне» at the durable Telegram ingress.
 *
 * Constructs covered:
 * - A press on a guest answer (an inline message: no `message`, only `inline_message_id`) parses as a
 *   callback, reaches the guest reminder handler and completes without an Eve dispatch.
 */
import type { TelegramDrainContext } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import type { TelegramIngressRepository } from "../telegram-ingress-contract.js";
import { createTelegramDurableIngress } from "../telegram-durable-ingress.js";

describe("guest reminder press at the durable ingress", () => {
  it("is handled by the application and never dispatched to Eve", async () => {
    const claim = {
      attemptCount: 1,
      deliveryContinuationKey: "telegram:callback:query-9",
      ingressContinuationKey: "telegram:callback:query-9",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseToken: "123e4567-e89b-42d3-a456-426614174000",
      payload: {
        callback_query: {
          chat_instance: "-42",
          data: "gr:0b0e5a8e-3f43-4a6b-9a4e-5c1b2d3e4f50",
          from: { first_name: "Максим", id: 202, is_bot: false },
          id: "query-9",
          inline_message_id: "AgAAAInline",
        },
        update_id: 7101,
      },
      queueId: "123e4567-e89b-42d3-a456-426614174001",
      transcript: null,
      updateId: "7101",
      voice: null,
    };
    const repository = {
      acceptMedia: vi.fn(),
      beginDispatch: vi.fn(),
      beginVoiceTranscription: vi.fn(),
      claimFollowing: vi.fn().mockResolvedValue([]),
      claimNext: vi.fn().mockResolvedValueOnce(claim).mockResolvedValueOnce(null),
      complete: vi.fn(),
      completeWithSession: vi.fn(),
      enqueue: vi.fn(),
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
    } satisfies TelegramIngressRepository;
    const handleGuestReminderCallback = vi.fn().mockResolvedValue(true);
    const dispatch = vi.fn();
    let backgroundTask: Promise<unknown> | undefined;
    const ingress = createTelegramDurableIngress({
      acceptMedia: vi.fn(),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleGuestMessage: vi.fn(),
      handleGuestReminderCallback,
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository,
      requestSessionRotation: vi.fn(),
      transcribeVoice: vi.fn(),
    });

    await ingress.drain({ dispatch, waitUntil(task) { backgroundTask = task; } } as TelegramDrainContext);
    await backgroundTask;

    expect(handleGuestReminderCallback).toHaveBeenCalledWith(expect.objectContaining({
      data: "gr:0b0e5a8e-3f43-4a6b-9a4e-5c1b2d3e4f50",
      from: expect.objectContaining({ id: "202" }),
      id: "query-9",
    }));
    expect(repository.complete).toHaveBeenCalledWith("7101", claim.leaseToken);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
