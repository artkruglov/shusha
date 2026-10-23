/**
 * Durable Telegram ingress coordinator.
 *
 * Exports:
 * - `createTelegramDurableIngress`: verified Eve hook that persists before ACK and drains FIFO.
 * - `handleTelegramDurableIngress`: production hook with PostgreSQL and Groq dependencies.
 * - Application software-update callbacks complete before native Eve dispatch begins.
 */
import type {
  TelegramDrainContext,
  TelegramGuestUpdateContext,
  TelegramMessage,
  TelegramUpdate,
  TelegramVerifiedUpdateContext,
} from "eve/channels/telegram";
import { parseTelegramUpdate } from "eve/channels/telegram";

import {
  TELEGRAM_INGRESS_LEASE_MS,
  TELEGRAM_INGRESS_MAX_CONCURRENT_CALLBACK_DRAINS,
  TELEGRAM_INGRESS_MAX_CONCURRENT_DRAINS,
  TELEGRAM_PRIVATE_BURST_MAX_WAIT_MS,
  TELEGRAM_PRIVATE_BURST_QUIET_MS,
} from "../config.js";
import { AppError } from "./app-error.js";
import { transcribeTelegramVoice } from "./groq-voice-transcription.js";
import type { TelegramIngressClaim, TelegramIngressRepository, TelegramPrivateBurstPolicy } from "./telegram-ingress-contract.js";
import { sendTelegramFailureNotice, type TelegramFailureNotice } from "./telegram-failure-notice.js";
import { ingressFailure, settleIngressTransition } from "./telegram-ingress-failure.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";
import { isMessageAddressedToBot, type TelegramInboundMediaKind } from "./telegram-message-policy.js";
import { createTelegramVoiceAuthorizer } from "./telegram-voice-authorization.js";
import {
  TELEGRAM_SERIES_MAX_MESSAGES,
  continuesSeries,
  isSeriesEligible,
  type TelegramSeriesMarker,
  withSeriesMarker,
} from "./telegram-message-series.js";
import {
  pendingMessagesFromPayloads,
  TELEGRAM_PENDING_MESSAGES_MAX,
  type TelegramPendingMessage,
  withPendingMarker,
} from "./telegram-pending-messages.js";
import { normalizeRichMessage } from "./telegram-rich-message.js";
import { prepareRichIngress, richIngressPayload } from "./telegram-rich-ingress.js";
import {
  shouldTranscribeVoice,
  isTelegramChatJoinRequest,
  telegramGuestMessage,
  telegramGuestQueueKey,
  telegramJoinQueueKey,
  telegramQueueKey,
  telegramUpdateId,
  telegramVoiceMetadata,
  withCaptionlessAttachmentText,
  withTranscript,
} from "./telegram-ingress-update.js";
import { withTelegramUpdateMarker } from "./telegram-update-marker.js";
import { telegramRepository } from "./telegram-repository.js";
import { handleSoftwareUpdateCallback } from "./software-updates/callback.js";
import { handleChatJoinRequest, handleGroupJoinCallback } from "./group-join/group-join.js";
import { handleGuestReminderCallback } from "./guest/guest-reminder-callback.js";
import { handleTaskButtonCallback } from "./task-buttons/task-button-callback-production.js";
import { staleTaskTurn } from "./task-buttons/stale-task-turn.js";
import { answerTelegramGuestMessage } from "./guest/guest-answer.js";
import { sessionRepository } from "./sessions/session-repository.js";
import {
  type EveSessionResult,
  isLostSessionBoundary,
  waitForSessionBoundary,
} from "./telegram-session-boundary.js";

interface DurableIngressDependencies {
  acceptMedia(
    message: Pick<TelegramMessage, "chat">,
    updateId: string,
    mediaKind: Exclude<TelegramInboundMediaKind, "none">,
    textFallback: boolean,
  ): Promise<boolean>;
  authorizeVoice(message: Pick<TelegramMessage, "chat" | "from">): Promise<boolean>;
  botUsername: string;
  /** Quiet window before a private head is claimed; tests pass zero to claim at once. */
  privateBurst?: TelegramPrivateBurstPolicy;
  /**
   * Drain loops allowed at once. `claimNext` keeps every chat/topic FIFO on its own, so parallel
   * loops only stop one long turn from holding every other chat and every approval button.
   */
  maxConcurrentDrains?: number;
  /**
   * Extra drain loops that lease only button presses. A press resumes a parked turn and must not
   * wait until one of the message loops, each possibly holding a turn of several minutes, frees up.
   */
  maxConcurrentCallbackDrains?: number;
  /**
   * Answers a guest message (Bot API 10.0) without an Eve session. Telegram accepts one answer per
   * query, so it runs under the dispatch marker and an ambiguous crash is never answered twice.
   */
  handleGuestMessage(message: Record<string, unknown>, updateId: string): Promise<void>;
  /**
   * Greets a person who asks to enter a group by the bot's invite link (`group-join.ts`); runs under the
   * dispatch marker like a guest answer, so an ambiguous crash never greets twice.
   */
  handleChatJoinRequest?(raw: Record<string, unknown>): Promise<void>;
  /** «Вступить», «Пустить» and the rest under a join greeting; true when the press was one. */
  handleGroupJoinCallback?(
    query: Extract<TelegramUpdate, { kind: "callback_query" }>["callbackQuery"],
  ): Promise<boolean>;
  /** «Напомнить и мне» under a guest answer; true when the press was this button's. */
  handleGuestReminderCallback(
    query: Extract<TelegramUpdate, { kind: "callback_query" }>["callbackQuery"],
  ): Promise<boolean>;
  handleSoftwareUpdateCallback(
    query: Extract<TelegramUpdate, { kind: "callback_query" }>["callbackQuery"],
  ): Promise<boolean>;
  /** «Помоги начать» (`stale-task-turn.ts`): the press as the presser's own private message, or null. */
  taskButtonTurn?(
    query: Extract<TelegramUpdate, { kind: "callback_query" }>["callbackQuery"],
  ): Promise<TelegramUpdate | null>;
  /** A task button under a bot message (migration 179); true when the press was one. */
  handleTaskButtonCallback?(
    query: Extract<TelegramUpdate, { kind: "callback_query" }>["callbackQuery"],
  ): Promise<boolean>;
  leaseMilliseconds: number;
  /**
   * Tells the person in a private chat that a message of theirs was not processed. Failure texts are
   * written for people; without this they only reached the log (ilkruglov 5d80240e).
   */
  notifyFailure?(update: TelegramUpdate, failure: TelegramFailureNotice): Promise<void>;
  repository: TelegramIngressRepository;
  /**
   * Marks the application session of an Eve session for rotation after its turn boundary was
   * lost: its stream cursor is unknown, so a late event of that turn could close the next message.
   */
  requestSessionRotation(eveSessionId: string): Promise<void>;
  transcribeVoice(input: {
    fileId: string;
    fileSize?: number;
    mimeType?: string;
  }): Promise<string>;
}

interface TelegramDurableIngressHandler {
  (context: TelegramVerifiedUpdateContext): Promise<Response>;
  drain(context: TelegramDrainContext): Promise<Response>;
  guest(context: TelegramGuestUpdateContext): Promise<Response>;
  joinRequest(context: TelegramGuestUpdateContext): Promise<Response>;
}

const LEASE_HEARTBEAT_DIVISOR = 3;

const DEFAULT_MAX_CONCURRENT_DRAINS = 3;
const DEFAULT_MAX_CONCURRENT_CALLBACK_DRAINS = 2;

// The claim reads the clock after the timer fires; this margin keeps it past the ready moment.
const HELD_CHAT_WAKE_MARGIN_MS = 50;
const HELD_CHAT_POLL_SLICE_MS = 500;

export function createTelegramDurableIngress(dependencies: DurableIngressDependencies) {
  const privateBurst = dependencies.privateBurst ?? {
    maxWaitMilliseconds: TELEGRAM_PRIVATE_BURST_MAX_WAIT_MS,
    quietMilliseconds: TELEGRAM_PRIVATE_BURST_QUIET_MS,
  };
  const drainPools = {
    any: {
      active: new Set<Promise<void>>(),
      limit: dependencies.maxConcurrentDrains ?? DEFAULT_MAX_CONCURRENT_DRAINS,
    },
    callback: {
      active: new Set<Promise<void>>(),
      limit: dependencies.maxConcurrentCallbackDrains ?? DEFAULT_MAX_CONCURRENT_CALLBACK_DRAINS,
    },
  };

  async function maintainLease(
    updateId: string,
    leaseToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    const heartbeatMilliseconds = Math.floor(
      dependencies.leaseMilliseconds / LEASE_HEARTBEAT_DIVISOR,
    );
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, heartbeatMilliseconds);
        signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
      if (signal.aborted) return;
      await dependencies.repository.renewLease(
        updateId,
        leaseToken,
        dependencies.leaseMilliseconds,
      );
    }
  }

  async function rotateLostSession(eveSessionId: string, leasedUpdateId: string): Promise<void> {
    try {
      await dependencies.requestSessionRotation(eveSessionId);
      console.warn(JSON.stringify({
        code: "AGENT_TELEGRAM_SESSION_ROTATION_REQUESTED",
        eveSessionId,
        updateId: leasedUpdateId,
      }));
    } catch (error) {
      // The update still fails with its boundary code; a rotation failure must not replace it.
      console.error(JSON.stringify({
        code: "AGENT_TELEGRAM_SESSION_ROTATION_FAILED",
        error: error instanceof Error ? error.message : String(error),
        eveSessionId,
        updateId: leasedUpdateId,
      }));
    }
  }

  // Leases alive at the first drain of this process were held by a predecessor that died
  // mid-turn; releasing them once lets the affected chats resume in seconds instead of waiting
  // out the full lease. A redispatched update is deduplicated by the journal, so no turn repeats.
  // Every pool waits for the same single release, so no loop claims before it has finished.
  let staleLeasesRelease: Promise<void> | undefined;

  // A lost lease means another drain owns the message; anything else is the person's to know.
  async function notifyFailure(failed: TelegramIngressClaim, failure: TelegramFailureNotice): Promise<void> {
    if (!dependencies.notifyFailure || failure.code === "AGENT_TELEGRAM_LEASE_LOST") return;
    const update = parseTelegramUpdate(failed.payload);
    if (update?.kind !== "message" || update.message.chat.type !== "private") return;
    try {
      await dependencies.notifyFailure(update, failure);
    } catch (error) {
      console.error(JSON.stringify({
        code: "AGENT_TELEGRAM_FAILURE_NOTICE_FAILED",
        error: error instanceof Error ? error.message : String(error),
        updateId: failed.updateId,
      }));
    }
  }

  type LeasedUpdate = { claim: TelegramIngressClaim; update: TelegramUpdate };

  // A run of consecutive messages from the author of `head` is leased together so one turn can
  // answer it; anything else stays in the queue and forms the next claim.
  async function claimSeriesFollowers(
    head: TelegramIngressClaim,
    update: TelegramUpdate,
  ): Promise<LeasedUpdate[]> {
    if (!isSeriesEligible(update, dependencies.botUsername) || update.kind !== "message") return [];
    if (await dependencies.repository.hasPendingApprovalsInChat(update.message.chat.id)) return [];
    const followers = await dependencies.repository.claimFollowing({
      accept: (payload) => {
        const candidate = parseTelegramUpdate(payload);
        return candidate !== null &&
          continuesSeries(update, normalizeRichMessage(candidate), dependencies.botUsername);
      },
      afterUpdateId: head.updateId,
      leaseMilliseconds: dependencies.leaseMilliseconds,
      limit: TELEGRAM_SERIES_MAX_MESSAGES - 1,
      queueId: head.queueId,
    });
    return followers.map((claim) => {
      const parsed = parseTelegramUpdate(claim.payload);
      if (!parsed) {
        throw new AppError(
          "AGENT_TELEGRAM_PAYLOAD_INVALID",
          "Не удалось подготовить сообщение серии для обработки",
        );
      }
      return { claim, update: normalizeRichMessage(parsed) };
    });
  }

  function seriesMarker(series: readonly LeasedUpdate[], index: number): TelegramSeriesMarker | null {
    if (series.length === 1) return null;
    if (index < series.length - 1) return { role: "context" };
    const messages = series.map((item) => (item.update as { message: TelegramMessage }).message);
    return {
      addressed: messages.some((message) =>
        isMessageAddressedToBot(message, dependencies.botUsername)
      ),
      // The ordinary turn checks these against messages a running turn already showed to the model.
      earlierUpdateIds: series.slice(0, -1).map((item) => item.claim.updateId),
      role: "current",
      telegramMessageIds: messages.slice(0, -1).map((message) => message.messageId),
    };
  }

  async function drain(
    dispatch: TelegramVerifiedUpdateContext["dispatch"],
    pool: keyof typeof drainPools,
  ): Promise<void> {
    staleLeasesRelease ??= dependencies.repository.releaseStaleLeases().then((released) => {
      if (released > 0) {
        console.warn(JSON.stringify({ code: "AGENT_TELEGRAM_INGRESS_LEASES_RELEASED", released }));
      }
    });
    await staleLeasesRelease;
    while (true) {
      const claim = await dependencies.repository.claimNext(
        dependencies.leaseMilliseconds,
        pool === "callback" ? { callbackOnly: true } : { burst: privateBurst },
      );
      if (!claim) {
        // A private chat still receiving a burst is held: sleep until it is ready instead of
        // leaving its reply to the next poll of the ingress worker.
        const wait = pool === "callback" ? null : await dependencies.repository.heldPrivateChatReadyIn?.(privateBurst);
        if (wait !== null && wait !== undefined && wait <= privateBurst.maxWaitMilliseconds) {
          // Sleep in short slices: a slot of the pool is held meanwhile, and a message of another chat
          // that arrives during the wait must be claimed by the next claimNext, not after the burst.
          await new Promise((resolve) => setTimeout(resolve, Math.min(wait + HELD_CHAT_WAKE_MARGIN_MS, HELD_CHAT_POLL_SLICE_MS)));
          continue;
        }
        return;
      }
      // One heartbeat per leased update, stopped right before that update's terminal transition:
      // a heartbeat that outlived its completed series member kept renewing a released lease,
      // failed after the next tick, and that failure sank the whole series minutes later.
      const heartbeatControllers = new Map<string, AbortController>();
      let heartbeatError: unknown;
      const heartbeats: Promise<void>[] = [];
      const startHeartbeat = (leased: TelegramIngressClaim): void => {
        const controller = new AbortController();
        heartbeatControllers.set(leased.updateId, controller);
        heartbeats.push(
          maintainLease(leased.updateId, leased.leaseToken, controller.signal)
            .catch((error: unknown) => {
              heartbeatError = error;
            }),
        );
      };
      const stopHeartbeat = (updateId: string): void => {
        heartbeatControllers.get(updateId)?.abort();
        heartbeatControllers.delete(updateId);
      };
      startHeartbeat(claim);
      // Every leased update that has not reached a terminal state yet, in queue order.
      const pending: TelegramIngressClaim[] = [claim];
      // Updates whose dispatch marker this attempt set: from then on the message may be in a turn.
      const dispatchStarted = new Set<string>();
      const beginDispatch = async (leased: TelegramIngressClaim): Promise<void> => {
        await dependencies.repository.beginDispatch(leased.updateId, leased.leaseToken);
        dispatchStarted.add(leased.updateId);
      };

      async function dispatchLeased(
        leased: TelegramIngressClaim,
        update: TelegramUpdate,
        marker: TelegramSeriesMarker | null,
        pendingAfter: readonly TelegramPendingMessage[],
      ): Promise<void> {
        await beginDispatch(leased);
        // The turn learns its own update id: messages queued after it can then be shown to it.
        const stamped = update.kind === "message" ? withTelegramUpdateMarker(update, leased.updateId) : update;
        const marked = marker !== null && stamped.kind === "message"
          ? withSeriesMarker(stamped, marker)
          : stamped;
        // The turn sees what the chat said after its message: otherwise it answered a snapshot
        // the conversation had already moved past, and two bots went in circles.
        const outbound = pendingAfter.length > 0 && marked.kind === "message"
          ? withPendingMarker(marked, pendingAfter)
          : marked;
        const session = (await dispatch(
          withCaptionlessAttachmentText(outbound),
        )) as EveSessionResult | null | undefined;
        if (!session) {
          stopHeartbeat(leased.updateId);
          await dependencies.repository.complete(leased.updateId, leased.leaseToken);
          return;
        }
        // The durable cursor excludes every event from earlier turns of a reused Eve session.
        const streamCursor = await dependencies.repository.sessionEventStreamCursor(session.id);
        let nextEventIndex: number;
        try {
          nextEventIndex = await waitForSessionBoundary(session, streamCursor, {
            ...(update.kind === "callback_query"
              ? {
                hasPendingApprovals: () =>
                  dependencies.repository.hasPendingApprovals(session.id),
              }
              : {}),
            // One message holds its chat and a drain loop for at most one silent lease.
            idleMilliseconds: dependencies.leaseMilliseconds,
            updateId: leased.updateId,
          });
        } catch (error) {
          if (isLostSessionBoundary(error)) await rotateLostSession(session.id, leased.updateId);
          throw error;
        }
        if (heartbeatError) throw heartbeatError;
        stopHeartbeat(leased.updateId);
        await dependencies.repository.completeWithSession(
          leased.updateId,
          leased.leaseToken,
          session.id,
          nextEventIndex,
        );
      }

      try {
        let payload = claim.payload;
        const guestMessage = telegramGuestMessage(payload);
        if (guestMessage) {
          await beginDispatch(claim);
          await dependencies.handleGuestMessage(guestMessage, claim.updateId);
          stopHeartbeat(claim.updateId);
          await dependencies.repository.complete(claim.updateId, claim.leaseToken);
          pending.shift();
          continue;
        }
        if (isTelegramChatJoinRequest(payload)) {
          await beginDispatch(claim);
          await dependencies.handleChatJoinRequest?.(payload);
          stopHeartbeat(claim.updateId);
          await dependencies.repository.complete(claim.updateId, claim.leaseToken);
          pending.shift();
          continue;
        }
        // Rich messages (Bot API 10.1) carry their text in blocks; Eve reads only `text`.
        let update = parseTelegramUpdate(payload);
        if (update) update = normalizeRichMessage(update);
        if (!update) {
          await dependencies.repository.complete(claim.updateId, claim.leaseToken);
          pending.shift();
          continue;
        }

        // One button asks the model, so its press goes on as the presser's message, not as a callback.
        if (update.kind === "callback_query") update = await dependencies.taskButtonTurn?.(update.callbackQuery) ?? update;

        // Application update decisions are durable DB transitions and never enter an Eve session.
        if (
          update.kind === "callback_query" && (
            await dependencies.handleSoftwareUpdateCallback(update.callbackQuery) ||
            await dependencies.handleGuestReminderCallback(update.callbackQuery) ||
            await (dependencies.handleGroupJoinCallback?.(update.callbackQuery) ?? false) ||
            await (dependencies.handleTaskButtonCallback?.(update.callbackQuery) ?? false)
          )
        ) {
          await dependencies.repository.complete(claim.updateId, claim.leaseToken);
          pending.shift();
          continue;
        }

        if (claim.voice && update.kind === "message" && shouldTranscribeVoice(update.message)) {
          const authorized = await dependencies.authorizeVoice(update.message);
          if (authorized) {
            if (!claim.transcript) {
              await dependencies.repository.beginVoiceTranscription(
                claim.updateId,
                claim.leaseToken,
              );
            }
            const transcript =
              claim.transcript ?? (await dependencies.transcribeVoice(claim.voice)).trim();
            // В личном чате человек ждёт ответа именно на это сообщение, поэтому пустой
            // транскрипт — понятная ошибка. В группе речь распознаётся ради адресации, и смех или
            // музыка не должны ронять update: иначе сообщение пропадает даже из журнала.
            if (!transcript && update.message.chat.type === "private") {
              throw new AppError(
                "AGENT_VOICE_TRANSCRIPT_EMPTY",
                "В голосовом сообщении не удалось распознать речь. Запишите его ещё раз",
              );
            }
            if (!transcript) {
              console.warn(JSON.stringify({
                code: "AGENT_VOICE_TRANSCRIPT_EMPTY_IN_GROUP",
                chatType: update.message.chat.type,
              }));
            }
            if (transcript) {
              if (!claim.transcript) {
                await dependencies.repository.saveVoiceTranscript(
                  claim.updateId,
                  claim.leaseToken,
                  transcript,
                );
              }
              payload = withTranscript(payload, transcript);
              update = parseTelegramUpdate(payload);
            }
            if (update) update = normalizeRichMessage(update);
            if (!update) {
              throw new AppError(
                "AGENT_TELEGRAM_PAYLOAD_INVALID",
                "Не удалось подготовить голосовое сообщение для обработки",
              );
            }
          }
        }

        const series: LeasedUpdate[] = [{ claim, update }];
        for (const follower of await claimSeriesFollowers(claim, update)) {
          series.push(follower);
          pending.push(follower.claim);
          startHeartbeat(follower.claim);
        }
        if (series.length > 1) {
          console.info(JSON.stringify({
            code: "AGENT_TELEGRAM_SERIES_CLAIMED",
            messages: series.length,
            updateIds: series.map((item) => item.claim.updateId),
          }));
        }
        const tail = series[series.length - 1]!;
        const pendingAfter = tail.update.kind === "message"
          ? pendingMessagesFromPayloads(await dependencies.repository.listPendingAfter({
            afterUpdateId: tail.claim.updateId,
            limit: TELEGRAM_PENDING_MESSAGES_MAX,
            queueId: tail.claim.queueId,
          }))
          : [];
        for (let index = 0; index < series.length; index += 1) {
          const item = series[index]!;
          const last = index === series.length - 1;
          await dispatchLeased(item.claim, item.update, seriesMarker(series, index), last ? pendingAfter : []);
          pending.shift();
        }
      } catch (error) {
        const failure = ingressFailure(error);
        console.error(
          JSON.stringify({
            code: failure.code,
            error: error instanceof Error ? error.message : String(error),
            updateId: pending[0]?.updateId ?? claim.updateId,
            ...(pending.length > 1 ? { seriesUpdateIds: pending.map((item) => item.updateId) } : {}),
          }),
        );
        // Only the message being prepared or dispatched failed; the rest of its series never reached
        // Eve and goes back to the queue (ilkruglov 5d80240e: after a restart two fresh messages failed
        // together with a head whose interrupted dispatch was refused as possibly double). Each
        // transition is settled on its own: a lost lease on one must not keep the tail leased or hide
        // the original error, which is rethrown below.
        const [failed, ...untouched] = pending;
        if (failed) {
          stopHeartbeat(failed.updateId);
          const settled = await settleIngressTransition("fail", failed.updateId, failure.code, () =>
            dependencies.repository.fail(failed.updateId, failed.leaseToken, failure));
          if (settled) {
            await notifyFailure(failed, { ...failure, dispatchStarted: dispatchStarted.has(failed.updateId) });
          }
        }
        for (const leased of untouched) {
          stopHeartbeat(leased.updateId);
          await settleIngressTransition("release", leased.updateId, failure.code, () =>
            dependencies.repository.release(leased.updateId, leased.leaseToken, {
              code: "AGENT_TELEGRAM_SERIES_RETURNED",
              message: "Сообщение вернулось в очередь: предыдущее сообщение серии не обработано",
            }));
        }
        throw error;
      } finally {
        for (const controller of heartbeatControllers.values()) controller.abort();
        await Promise.all(heartbeats);
      }
    }
  }

  function scheduleDrain(context: TelegramDrainContext): void {
    // Each trigger adds at most one loop; a loop ends when no claimable update remains. A message
    // loop also takes button presses, so the callback pool is started only when every message loop
    // is busy, which is exactly when a press would otherwise wait for a long turn to finish. Guest
    // messages ride the callback pool too: a guest query must not wait behind family turns.
    const pool = drainPools.any.active.size < drainPools.any.limit
      ? drainPools.any
      : drainPools.callback.active.size < drainPools.callback.limit ? drainPools.callback : null;
    if (pool) {
      const scheduled: Promise<void> = drain(
        context.dispatch,
        pool === drainPools.any ? "any" : "callback",
      ).finally(() => {
        pool.active.delete(scheduled);
      });
      pool.active.add(scheduled);
    }
    for (const running of [...drainPools.any.active, ...drainPools.callback.active]) {
      context.waitUntil(running);
    }
  }

  const handleVerifiedUpdate = async function handleVerifiedUpdate(
    context: TelegramVerifiedUpdateContext,
  ): Promise<Response> {
    const incomingUpdateId = telegramUpdateId(context.raw);
    // A rich post meets the gate with its one file lifted; its text may outlive a refused file.
    const rich = prepareRichIngress(context.update);
    const { mediaKind, update } = rich;
    // External media is acknowledged before durable storage, download, transcription, or Eve dispatch.
    const mediaAccepted = update.kind !== "message" || mediaKind === "none" ||
      await dependencies.acceptMedia(update.message, incomingUpdateId, mediaKind, rich.textFallback);
    const payload = richIngressPayload(context.raw, rich, mediaAccepted);
    if (payload === null) return new Response("ok");
    const voice = telegramVoiceMetadata(context.raw);
    await dependencies.repository.enqueue({
      continuationKey: telegramQueueKey(update),
      payload,
      updateId: incomingUpdateId,
      ...(voice ? { voice } : {}),
    });
    scheduleDrain(context);
    return new Response("ok");
  };

  // A guest message is stored before the ACK like any update and answered later by the drain.
  handleVerifiedUpdate.guest = async (context: TelegramGuestUpdateContext): Promise<Response> => {
    await dependencies.repository.enqueue({
      continuationKey: telegramGuestQueueKey(context.raw),
      payload: context.raw,
      updateId: telegramUpdateId(context.raw),
    });
    scheduleDrain(context);
    return new Response("ok");
  };

  // A join request is stored before the ACK like any update and greeted later by the drain.
  handleVerifiedUpdate.joinRequest = async (context: TelegramGuestUpdateContext): Promise<Response> => {
    await dependencies.repository.enqueue({
      continuationKey: telegramJoinQueueKey(context.raw),
      payload: context.raw,
      updateId: telegramUpdateId(context.raw),
    });
    scheduleDrain(context);
    return new Response("ok");
  };

  // The private poller uses the same native dispatcher without creating a synthetic update.
  handleVerifiedUpdate.drain = async (context: TelegramDrainContext): Promise<Response> => {
    scheduleDrain(context);
    return new Response("ok");
  };
  return handleVerifiedUpdate as TelegramDurableIngressHandler;
}

const authorizeTelegramVoice = createTelegramVoiceAuthorizer(telegramRepository);

export const handleTelegramDurableIngress = createTelegramDurableIngress({
  acceptMedia(message, incomingUpdateId, mediaKind, textFallback) {
    return telegramIngressRepository.acceptMedia({
      chatId: message.chat.id,
      chatType: message.chat.type,
      mediaKind,
      textFallback,
      updateId: incomingUpdateId,
    });
  },
  authorizeVoice: authorizeTelegramVoice,
  botUsername: process.env.TELEGRAM_BOT_USERNAME as string,
  handleChatJoinRequest,
  handleGroupJoinCallback,
  handleGuestMessage: answerTelegramGuestMessage,
  handleGuestReminderCallback,
  handleTaskButtonCallback,
  taskButtonTurn: staleTaskTurn,
  handleSoftwareUpdateCallback,
  leaseMilliseconds: TELEGRAM_INGRESS_LEASE_MS,
  maxConcurrentCallbackDrains: TELEGRAM_INGRESS_MAX_CONCURRENT_CALLBACK_DRAINS,
  maxConcurrentDrains: TELEGRAM_INGRESS_MAX_CONCURRENT_DRAINS,
  notifyFailure: sendTelegramFailureNotice,
  repository: telegramIngressRepository,
  async requestSessionRotation(eveSessionId) {
    const applicationSessionId = await sessionRepository.findActiveIdByEveSessionId(eveSessionId);
    if (applicationSessionId === null) return;
    await sessionRepository.requestRotation(applicationSessionId, "session_failed");
  },
  transcribeVoice: transcribeTelegramVoice,
});
