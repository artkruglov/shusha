/**
 * Failure path of the durable Telegram ingress.
 *
 * Constructs covered:
 * - `HookNotFoundError` after dispatch is ambiguous in Eve 0.40.0: the update fails once with a
 *   conditional notice, keeps its dispatch marker and is never dispatched again.
 * - A failure before dispatch keeps its own plain sentence; one after dispatch is always conditional.
 * - A transition that throws (a lost lease) neither keeps the rest of the series leased nor hides the
 *   original error.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "./app-error.js";
import type { TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import { failureNoticeText, UNCERTAIN_DELIVERY_NOTICE } from "./telegram-failure-notice.js";

const LEASE_PREFIX = "123e4567-e89b-42d3-a456-4266141740";

function claim(updateId: number, text: string) {
  return {
    attemptCount: 1,
    deliveryContinuationKey: "505::",
    ingressContinuationKey: "505::",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    leaseToken: `${LEASE_PREFIX}${String(updateId).slice(-2)}`,
    payload: {
      message: {
        chat: { first_name: "Пух", id: 505, type: "private" },
        date: 1_788_563_816 + updateId,
        from: { first_name: "Пух", id: 505, is_bot: false },
        message_id: updateId,
        text,
      },
      update_id: updateId,
    },
    queueId: "123e4567-e89b-42d3-a456-426614174001",
    transcript: null,
    updateId: String(updateId),
    voice: null,
  };
}

function repository() {
  return {
    acceptMedia: vi.fn().mockResolvedValue(true),
    beginDispatch: vi.fn(),
    beginVoiceTranscription: vi.fn().mockResolvedValue("started"),
    claimFollowing: vi.fn().mockResolvedValue([]),
    claimNext: vi.fn(),
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
  } satisfies TelegramIngressRepository;
}

function hookMissing(): Error {
  return Object.assign(new Error("Hook not found"), { name: "HookNotFoundError" });
}

async function drainOnce(
  storage: ReturnType<typeof repository>,
  dispatch: ReturnType<typeof vi.fn>,
  extra: { transcribeVoice?: () => Promise<string> } = {},
) {
  const notifyFailure = vi.fn().mockResolvedValue(undefined);
  const handle = createTelegramDurableIngress({
    acceptMedia: vi.fn().mockResolvedValue(true),
    authorizeVoice: vi.fn().mockResolvedValue(true),
    botUsername: "osinara_bot",
    handleGuestMessage: vi.fn(),
    handleGuestReminderCallback: vi.fn().mockResolvedValue(false),
    handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
    leaseMilliseconds: 60_000,
    notifyFailure,
    repository: storage,
    requestSessionRotation: vi.fn(),
    transcribeVoice: extra.transcribeVoice ?? vi.fn(),
  });
  const tasks: Promise<unknown>[] = [];
  await handle.drain({ dispatch, waitUntil: (task: Promise<unknown>) => tasks.push(task) } as never);
  const outcomes = await Promise.allSettled(tasks);
  return { notifyFailure, outcomes };
}

describe("durable ingress failure path", () => {
  it("fails a message after HookNotFoundError with a conditional notice and never dispatches it again", async () => {
    const storage = repository();
    const head = claim(4001, "Купи молоко");
    storage.claimNext.mockResolvedValueOnce(head).mockResolvedValueOnce(null);
    const dispatch = vi.fn().mockRejectedValue(hookMissing());
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const first = await drainOnce(storage, dispatch);

    expect(first.outcomes[0]).toMatchObject({ reason: { name: "HookNotFoundError" }, status: "rejected" });
    expect(storage.fail).toHaveBeenCalledTimes(1);
    expect(storage.fail).toHaveBeenCalledWith("4001", head.leaseToken, expect.objectContaining({
      code: "AGENT_TELEGRAM_SESSION_HOOK_AMBIGUOUS",
    }));
    expect(storage.release).not.toHaveBeenCalled();
    const notice = first.notifyFailure.mock.calls[0]![1];
    expect(notice).toMatchObject({ code: "AGENT_TELEGRAM_SESSION_HOOK_AMBIGUOUS", dispatchStarted: true });
    expect(failureNoticeText(notice)).toBe(UNCERTAIN_DELIVERY_NOTICE);

    // Even if the record came back (an expired lease), its marker refuses a second dispatch.
    storage.claimNext.mockReset().mockResolvedValueOnce({ ...head, attemptCount: 2 }).mockResolvedValueOnce(null);
    storage.beginDispatch.mockRejectedValueOnce(new AppError(
      "AGENT_TELEGRAM_DISPATCH_RECOVERY_REQUIRED",
      "Не уверена, что обработала это сообщение: если ответа на него не было, отправьте его ещё раз.",
    ));
    const second = await drainOnce(storage, dispatch);
    logged.mockRestore();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(failureNoticeText(second.notifyFailure.mock.calls[0]![1])).toBe(UNCERTAIN_DELIVERY_NOTICE);
  });

  it("returns the untouched series tail to the queue when the head fails with HookNotFoundError", async () => {
    const storage = repository();
    const head = claim(4101, "первое");
    const tail = claim(4102, "второе");
    storage.claimNext.mockResolvedValueOnce(head).mockResolvedValueOnce(null);
    storage.claimFollowing.mockResolvedValueOnce([tail]);
    const dispatch = vi.fn().mockRejectedValue(hookMissing());
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await drainOnce(storage, dispatch);
    logged.mockRestore();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(storage.fail.mock.calls.map((call) => call[0])).toEqual(["4101"]);
    expect(storage.release.mock.calls.map((call) => call[0])).toEqual(["4102"]);
  });

  it("keeps the plain sentence of a failure that happened before dispatch", async () => {
    const storage = repository();
    const voice = { ...claim(4201, ""), voice: { fileId: "voice-file-1" } };
    voice.payload.message = { ...voice.payload.message, voice: { duration: 1, file_id: "voice-file-1" } } as never;
    storage.claimNext.mockResolvedValueOnce(voice).mockResolvedValueOnce(null);
    const transcribeVoice = vi.fn<() => Promise<string>>().mockRejectedValue(new AppError(
      "AGENT_VOICE_FILE_TOO_LARGE",
      "Голосовое сообщение слишком длинное. Отправьте более короткую запись",
    ));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const { notifyFailure } = await drainOnce(storage, vi.fn(), { transcribeVoice });
    logged.mockRestore();

    const notice = notifyFailure.mock.calls[0]![1];
    expect(notice).toMatchObject({ dispatchStarted: false });
    expect(failureNoticeText(notice)).toBe("Голосовое сообщение слишком длинное. Отправьте более короткую запись");
  });

  it("releases the series tail and rethrows the original error when fail() loses its lease", async () => {
    const storage = repository();
    const head = claim(4301, "первое");
    const tail = [claim(4302, "второе"), claim(4303, "третье")];
    storage.claimNext.mockResolvedValueOnce(head).mockResolvedValueOnce(null);
    storage.claimFollowing.mockResolvedValueOnce(tail);
    storage.fail.mockRejectedValueOnce(new AppError("AGENT_TELEGRAM_LEASE_LOST", "Срок обработки истёк"));
    storage.release.mockRejectedValueOnce(new AppError("AGENT_TELEGRAM_LEASE_LOST", "Срок обработки истёк"));
    const original = new Error("AGENT_TEST_DISPATCH_FAILED: сбой");
    const dispatch = vi.fn().mockRejectedValue(original);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const { notifyFailure, outcomes } = await drainOnce(storage, dispatch);
    const lines = logged.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    logged.mockRestore();

    expect(outcomes[0]).toEqual({ reason: original, status: "rejected" });
    // The first tail release also failed; the second member is still returned to the queue.
    expect(storage.release.mock.calls.map((call) => call[0])).toEqual(["4302", "4303"]);
    expect(lines.filter((line) => line.code === "AGENT_TELEGRAM_INGRESS_TRANSITION_FAILED")).toEqual([
      expect.objectContaining({ originalCode: "AGENT_TELEGRAM_INGRESS_FAILED", transition: "fail", transitionCode: "AGENT_TELEGRAM_LEASE_LOST", updateId: "4301" }),
      expect.objectContaining({ transition: "release", updateId: "4302" }),
    ]);
    // The record belongs to whoever holds the lease now; this drain does not speak for it.
    expect(notifyFailure).not.toHaveBeenCalled();
  });
});
