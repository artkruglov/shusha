/**
 * Eve Telegram channel.
 *
 * Constructs:
 * - Verified webhook transport with durable PostgreSQL ingress.
 * - Application-owned family/group authorization in `onMessage`.
 * - Durable identity-bound HITL callbacks and replies.
 * - Validated attachment persistence with model-safe workspace references.
 * - Completed ordinary/Rich Message or silent reaction delivery without speculative chat drafts.
 * - Interim progress notices delivered at most once per assistant step of an interactive turn.
 * - Scheduled final delivery bound to its owner-approved Telegram chat and forum topic.
 * - Verified group replies anchored to the triggering member message.
 * - Successfully delivered final group output persisted as one logical timeline entry.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { telegramChannel, type TelegramEventContext } from "eve/channels/telegram";

import { handleTelegramDurableIngress } from "../lib/telegram-durable-ingress.js";
import { formatTelegramTurnFailure, isUnrecoverableHistoryFailure } from "../lib/telegram-interface.js";
import { TELEGRAM_EVE_UPLOAD_POLICY } from "../lib/telegram-message-policy.js";
import { handleTelegramMessage } from "../lib/telegram-on-message.js";
import { completedTelegramOutput, isDeliberateSilence, silentGroupTurnRecord } from "../lib/telegram-progress.js";
import { deliverTelegramProgressNotice } from "../lib/telegram-progress-notice.js";
import { progressNoticeKey, telegramProgressNoticeDeferral } from "../lib/telegram-progress-deferral.js";
import { TELEGRAM_KEEP_OPEN_DIRECTIVE } from "../lib/telegram-authored-split.js";
import { takeTelegramKeepOpenMark } from "../lib/telegram-keep-open-turns.js";
import { takeTurnBoard } from "../lib/telegram-turn-board.js";
import { questTurnActor } from "../lib/onboarding-quest/quest-after-success.js";
import { advanceQuestAfterSuccess } from "../lib/onboarding-quest/quest-production.js";
import { refreshTelegramReactionPolicy } from "../lib/telegram-reaction-policy.js";
import {
  telegramAudienceWatch,
  type TelegramCountRequest,
} from "../lib/spaces/telegram-audience-watch.js";
import {
  authorizeSpaceDelivery,
  notifySuspendedDelivery,
  spaceDeliveryRequestFromAuth,
} from "../lib/spaces/space-delivery-authorization.js";
import { asidePauseMilliseconds } from "../lib/telegram-aside-pacing.js";
import { stripTelegramAsideDirectives } from "../lib/telegram-authored-split.js";
import {
  deliverTelegramFinalOutput,
  suspendTelegramFinalOutput,
} from "../lib/telegram-final-delivery.js";
import { memoryReviewOwnerAlertTransport } from "../lib/memory-review/memory-review-owner-alert-transport.js";
import { telegramFinalDeliveryRepository } from "../lib/telegram-final-delivery-repository.js";
import { postTelegramRichMessageChunk } from "../lib/telegram-rich-messages.js";
import { postTelegramPlainMessageChunk } from "../lib/telegram-plain-messages.js";
import {
  applicationSessionId,
  registerTelegramDeliveredMessageRoutes,
} from "../lib/sessions/session-context.js";
import { sessionRepository } from "../lib/sessions/session-repository.js";
import { groupTimelineCursorRepository } from "../lib/sessions/group-timeline-cursor-repository.js";
import { authorizeTelegramHitlCallback } from "../lib/telegram-hitl/callback-authorization.js";
import { handleTelegramInputRequested } from "../lib/telegram-hitl/input-request.js";
import { telegramHitlApprovalRepository } from "../lib/telegram-hitl/approval-repository.js";
import { requireInternalToken } from "../lib/telegram-hitl/approval-timeout-sweep.js";
import {
  handleTelegramSessionFailure,
} from "../lib/telegram-session-failure.js";
import { telegramTurnReplyParameters } from "../lib/telegram-reply.js";
import { agentScheduleDispatchRepository } from "../lib/agent-schedules/agent-schedule-dispatch-repository.js";
import {
  isScheduledSession,
  scheduledDeliveryMetadata,
} from "../lib/agent-schedules/scheduled-session.js";
import {
  requireScheduledTelegramTarget,
  SCHEDULED_TELEGRAM_TARGET_MISMATCH_CODE,
  scheduledTelegramTargetMatches,
} from "../lib/agent-schedules/scheduled-telegram-target.js";
import { proactiveDeliveryRepository } from "../lib/proactive-deliveries/proactive-delivery-repository.js";
import { telegramGroupJournalRepository } from "../lib/telegram-group-journal-repository.js";
import { postTelegramMessageWithoutContinuationChange } from "../lib/telegram-stable-delivery.js";
import { shouldNotifyTelegramFailure } from "../lib/telegram-failure-notification.js";
import { AppError, isAppError } from "../lib/app-error.js";
import { conversationTimelineRepository } from "../lib/conversation-timeline-repository.js";
import { setTelegramMessageReaction } from "../lib/telegram-message-reaction.js";
import {
  bindMemoryTurnSources,
  releaseMemoryTurnSources,
} from "../lib/memory-turn-source.js";
import { memoryReviewBatchId } from "../lib/memory-review/memory-review-session.js";
import { keepTelegramTurnTyping, stopTelegramTurnTyping } from "../lib/telegram-typing-heartbeat.js";
import {
  allowTelegramTurnSteps,
  beginTelegramTurnSteps,
  closeTelegramTurnSteps,
  recordTelegramTurnSteps,
} from "../lib/telegram-step-status-channel.js";
import { resolveMemoryReviewBatch } from "../lib/memory-review/memory-review-turn-binding.js";
import { memoryReviewRepository } from "../lib/memory-review/memory-review-repository.js";
import { memoryReviewDispatchRepository } from "../lib/memory-review/memory-review-dispatch-repository.js";
import { isTelegramChannelSession } from "../lib/telegram-session-actor.js";
import { reinforceUsedMemories } from "../lib/memory-used-reinforcement.js";
import { attachReceiptUndo } from "../lib/task-buttons/receipt-undo.js";
import {
  formatTaskTurnReceipt, readTaskTurnReceipt, receiptGoesAlone, type TaskTurnCreated, type TaskTurnUndo,
} from "../lib/task-turn-receipt.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Счётчик участников спрашивают не чаще раза в минуту и только у чата с доказанной аудиторией. */
async function watchTelegramAudience(
  channel: { telegram: { chatId: string; request: TelegramCountRequest } },
  ctx: { session: { auth: { current: Parameters<typeof spaceDeliveryRequestFromAuth>[0] } } },
): Promise<void> {
  const attributes = ctx.session.auth.current?.attributes;
  const familyId = attributes?.familyId;
  const groupId = attributes?.groupId;
  if (typeof familyId !== "string" || typeof groupId !== "string") return;
  try {
    await telegramAudienceWatch(channel.telegram.request)({
      familyId, groupId, now: new Date(), telegramChatId: channel.telegram.chatId,
    });
  } catch (error) {
    // Сверка это наблюдение, а не право: её сбой не должен ронять ход. Разрешение всё равно
    // истечёт само по окну свежести, если счётчик перестал отвечать.
    console.error(JSON.stringify({
      code: "AGENT_SPACE_AUDIENCE_WATCH_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
  }
}

type ReceiptContext = { session: { id: string; auth: { current: { attributes?: Readonly<Record<string, unknown>> } | null } } };

interface TurnReceipt {
  readonly familyId: string;
  /** What the turn closed; null when it only wrote tasks, whose buttons go under the answer itself. */
  readonly line: string | null;
  readonly telegramUserId: string;
  readonly undo: readonly TaskTurnUndo[];
  readonly created: readonly TaskTurnCreated[];
  readonly askDefault: boolean;
}

/**
 * The board the person asked to see goes after the answer as its own message, built by code with «✓» inside
 * (`telegram-turn-board.ts`, `task-buttons/board-buttons.ts`): a press redraws the whole board, never the answer.
 * Like a progress notice it is not a durable final delivery: a failure is logged, and the answer stands.
 */
async function sendTurnBoard(channel: TelegramEventContext, noticeKey: string): Promise<void> {
  const board = takeTurnBoard(noticeKey);
  if (board === null) return;
  try {
    await postTelegramRichMessageChunk(board.markdown, channel.telegram, channel.state);
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_TASK_BOARD_DELIVERY_FAILED", error: error instanceof Error ? error.message.slice(0, 160) : String(error),
    }));
  }
}

/** The receipt of the tasks this turn really closed, or `null`; a failed read gives no receipt. */
async function taskTurnReceipt(ctx: ReceiptContext): Promise<TurnReceipt | null> {
  const attributes = ctx.session.auth.current?.attributes;
  const familyId = attributes?.familyId;
  const telegramUserId = attributes?.telegramUserId;
  const startedAt = attributes?.telegramTurnStartedAt;
  if (typeof familyId !== "string" || typeof telegramUserId !== "string" || typeof startedAt !== "string") return null;
  try {
    // A turn without a group is the person's private chat: there the receipt also says who sees a new task.
    const receipt = await readTaskTurnReceipt({
      eveSessionId: ctx.session.id, familyId, privateChat: typeof attributes?.groupId !== "string",
      since: new Date(startedAt), telegramUserId,
    });
    const line = formatTaskTurnReceipt(receipt);
    return line === null && receipt.created.length === 0 ? null : {
      askDefault: receipt.askDefault, created: receipt.created, familyId, line, telegramUserId, undo: receipt.undo,
    };
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_TASK_RECEIPT_FAILED",
      error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
    }));
    return null;
  }
}

/** «↩ Вернуть» under the delivered message that carries the receipt (`receipt-undo.ts`). */
async function attachTurnReceiptUndo(receipt: TurnReceipt | null, chatId: string, messageId: string | null): Promise<void> {
  if (receipt === null) return;
  await attachReceiptUndo({
    askDefault: receipt.askDefault, chatId, created: receipt.created, familyId: receipt.familyId, messageId,
    telegramUserId: receipt.telegramUserId, undo: receipt.undo,
  });
}

/** Отбивка несёт текст модели, поэтому её аудитория проверяется тем же швом, что и ответ. */
async function deliveryAllowed(
  ctx: { session: { auth: { current: Parameters<typeof spaceDeliveryRequestFromAuth>[0] } } },
): Promise<boolean> {
  const request = spaceDeliveryRequestFromAuth(ctx.session.auth.current, new Date());
  if (request === null) return true;
  return (await authorizeSpaceDelivery(request)).allowed;
}

export default telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME as string,
  credentials: {
    webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN as string,
  },
  // Telegram holds the webhook secret; the internal drain route takes the agent's own token.
  drainCredentials: { webhookSecretToken: requireInternalToken },
  drainRoute: "/eve/v1/telegram-drain",
  // Durable ingress is FIFO; a later update must never cancel a paid or side-effecting active turn.
  turnPolicy: "queue",
  events: {
    async "input.requested"(data, channel, ctx) {
      stopTelegramTurnTyping(ctx);
      await closeTelegramTurnSteps(ctx);
      // The confirmation prompt is this step's visible reply; text the model wrote next to the
      // gated call would otherwise follow the prompt and repeat what the resumed turn says.
      telegramProgressNoticeDeferral.discard(progressNoticeKey(ctx.session.id, ctx.session.turn.id));
      if (isTelegramChannelSession(ctx.session.auth)) {
        throw new AppError(
          "AGENT_TELEGRAM_CHANNEL_APPROVAL_FORBIDDEN",
          "Сообщение от имени канала не может подтверждать действия. Напишите от личного аккаунта",
        );
      }
      return await handleTelegramInputRequested(data, channel, ctx);
    },
    async "message.completed"(data, channel, ctx) {
      // Model-authored pre-tool text is a user-visible progress update, not technical tool noise.
      if (isScheduledSession(ctx) && data.finishReason !== "stop") return;
      let output = completedTelegramOutput(data);
      const noticeKey = progressNoticeKey(ctx.session.id, ctx.session.turn.id);
      // A turn that closed tasks and then kept silent still owes the person the receipt: it goes
      // out alone, through the same delivery below. Text still held is the answer and carries it.
      let receiptOnly = false;
      let receipt: TurnReceipt | null = null;
      // The same goes for a board the person asked to see (`telegram-turn-board.ts`).
      if (!output && receiptGoesAlone({
        deliberateSilence: isDeliberateSilence(data),
        scheduled: isScheduledSession(ctx),
        textHeld: telegramProgressNoticeDeferral.isHeld(noticeKey),
      })) {
        receipt = await taskTurnReceipt(ctx);
        if (receipt !== null && receipt.line !== null) {
          output = { kind: "message", memoryUsedDeclared: false, memoryUsedRefs: [], message: receipt.line };
          receiptOnly = true;
        } else {
          // The board goes only where the answer could: this session, an audience the space allows.
          if (await sessionRepository.isCurrentEveSession(applicationSessionId(ctx), ctx.session.id) && await deliveryAllowed(ctx)) {
            await sendTurnBoard(channel, noticeKey);
          }
        }
      }
      if (!output) {
        if (data.finishReason !== "tool-calls") {
          stopTelegramTurnTyping(ctx);
          await closeTelegramTurnSteps(ctx);
        }
        const silent = silentGroupTurnRecord(data, ctx.session.auth.current?.attributes);
        if (silent) console.info(JSON.stringify(silent));
        // A scenario that found nothing worth saying ends here; turn.completed would record it as a
        // missing delivery, and the schedule's statistics would lie.
        if (isScheduledSession(ctx) && isDeliberateSilence(data)) {
          const completed = await agentScheduleDispatchRepository.completeSilentRun(
            applicationSessionId(ctx), ctx.session.id, new Date(),
          );
          console.info(JSON.stringify({ code: "AGENT_SCHEDULE_RUN_SILENT", completed }));
        }
        return;
      }
      const sessionId = applicationSessionId(ctx);
      if (!await sessionRepository.isCurrentEveSession(sessionId, ctx.session.id)) return;
      if (output.kind === "progress") {
        const progressText = output.message;
        // Отбивка несёт текст модели, значит это содержимое области: неподтверждённая аудитория
        // просто не получает её. Проверка стоит здесь, а не в самой отбивке: та глушит ошибки.
        if (!await deliveryAllowed(ctx)) {
          telegramProgressNoticeDeferral.discard(noticeKey);
          return;
        }
        // Held until the step names its tools: an answer written beside `remember` must not go
        // out twice, while text before a slow tool still reaches the person at once.
        telegramProgressNoticeDeferral.hold(noticeKey, {
          send: async ({ final }) => {
            // Held to the end, the text was the answer, and the receipt goes under it.
            const heldReceipt = final ? await taskTurnReceipt(ctx) : null;
            const lastMessageId = await deliverTelegramProgressNotice({
              applicationSessionId: sessionId,
              channel,
              eveSessionId: ctx.session.id,
              eveTurnId: ctx.session.turn.id,
              message: heldReceipt?.line ? `${progressText}\n\n${heldReceipt.line}` : progressText,
              stepIndex: data.stepIndex,
            });
            await attachTurnReceiptUndo(heldReceipt, channel.telegram.chatId, lastMessageId);
            if (final) await sendTurnBoard(channel, noticeKey);
            // The person has been told work is under way, so a group turn may show typing too.
            keepTelegramTurnTyping(channel, ctx, { afterNotice: true });
            allowTelegramTurnSteps(ctx);
          },
          stepIndex: data.stepIndex,
        });
        return;
      }
      telegramProgressNoticeDeferral.discard(noticeKey);
      // The answer itself is going out; a later tick would show typing under it, and the step
      // status has done its job.
      stopTelegramTurnTyping(ctx);
      await closeTelegramTurnSteps(ctx);
      const currentAttributes = ctx.session.auth.current?.attributes;
      const scheduledDelivery = scheduledDeliveryMetadata(ctx);
      if (output.kind === "reaction") {
        const telegramMessageId = currentAttributes?.telegramMessageId;
        if (isScheduledSession(ctx) || typeof telegramMessageId !== "string") {
          throw new AppError(
            "AGENT_TELEGRAM_REACTION_TARGET_MISSING",
            "Не удалось определить сообщение для реакции. Отправьте обращение ещё раз",
          );
        }
        // A declined reaction stays silent: a text emoji is not a reaction (owner's decision).
        await setTelegramMessageReaction(channel.telegram, telegramMessageId, output.emoji);
        // A reaction is no text to put the receipt under, so the receipt follows it alone.
        receipt = await taskTurnReceipt(ctx);
        if (receipt === null || receipt.line === null) {
          if (await deliveryAllowed(ctx)) await sendTurnBoard(channel, noticeKey);
          return;
        }
        output = { kind: "message", memoryUsedDeclared: false, memoryUsedRefs: [], message: receipt.line };
        receiptOnly = true;
      }
      // Что ход действительно закрыл, пишет код, а не модель (`task-turn-receipt.ts`).
      if (!isScheduledSession(ctx) && !receiptOnly) receipt = await taskTurnReceipt(ctx);
      const answer = receipt === null || receipt.line === null || receiptOnly ? output.message : `${output.message}\n\n${receipt.line}`;
      // Ход с итогом записи или закрытия дел показывается целиком (`telegram-keep-open-turns.ts`).
      const message = takeTelegramKeepOpenMark(noticeKey) ? `${TELEGRAM_KEEP_OPEN_DIRECTIVE}\n${answer}` : answer;
      const replyParameters = isScheduledSession(ctx)
        ? undefined
        : telegramTurnReplyParameters(channel.state, ctx);
      const durableText = stripTelegramAsideDirectives(message);
      const deliveryIdentity = {
        chatId: channel.telegram.chatId,
        messageThreadId: channel.telegram.messageThreadId ?? null,
        replyParameters: replyParameters ?? null,
      };
      const deliveryMarkdown = isScheduledSession(ctx) ? durableText : message;
      // Несовпавшая цель — нарушение контракта, а не вопрос об аудитории: она падает первой и до
      // любых обращений к базе.
      if (scheduledDelivery) requireScheduledTelegramTarget(channel.telegram, scheduledDelivery);
      // Право инициатора и адресат сообщения — разные проверки. Эта стоит раньше заявки на
      // отправку: приостановка, оставившая `status='started'`, сделала бы любой повтор
      // неизвестным исходом вместо честного отказа. Отпечаток приостановки обязан совпадать с
      // отпечатком отправки, иначе повтор не узнает свою строку.
      const deliveryRequest = spaceDeliveryRequestFromAuth(ctx.session.auth.current, new Date());
      const audience = deliveryRequest === null
        ? { allowed: true as const }
        : await authorizeSpaceDelivery(deliveryRequest);
      if (!audience.allowed) {
        await suspendTelegramFinalOutput({
          applicationSessionId: sessionId,
          deliveryIdentity,
          diagnosticCode: audience.code,
          eveSessionId: ctx.session.id,
          eveTurnId: ctx.session.turn.id,
          markdown: deliveryMarkdown,
        });
        console.error(JSON.stringify({
          code: "AGENT_SPACE_DELIVERY_SUSPENDED",
          reason: audience.code,
          telegramChatId: channel.telegram.chatId,
        }));
        // Приостановленный запуск расписания обязан закрыться сам: иначе его строка осталась бы
        // `running`, аренда расписания — вечной, и следующее вхождение не наступило бы никогда.
        if (scheduledDelivery) {
          await agentScheduleDispatchRepository.failRun(
            sessionId, ctx.session.id, audience.code, new Date(),
          );
        }
        const familyId = ctx.session.auth.current?.attributes.familyId;
        if (typeof familyId === "string") {
          await notifySuspendedDelivery({
            code: audience.code,
            deliver: (notice) => memoryReviewOwnerAlertTransport.deliver(notice),
            familyId,
            telegramChatId: channel.telegram.chatId,
          });
        }
        return;
      }
      if (scheduledDelivery) {
        // Database authorization is meaningful only when it protects the exact active side-effect target.
        await agentScheduleDispatchRepository.authorizeDelivery({
          applicationSessionId: sessionId,
          eveSessionId: ctx.session.id,
          familyId: scheduledDelivery.familyId,
          groupId: scheduledDelivery.groupId,
          messageThreadId: scheduledDelivery.messageThreadId,
          ownerUserId: scheduledDelivery.ownerUserId,
          runId: scheduledDelivery.runId,
          scope: scheduledDelivery.scope,
          telegramChatId: scheduledDelivery.telegramChatId,
        });
      }
      let sentMessages: Awaited<ReturnType<typeof deliverTelegramFinalOutput>>;
      try {
        sentMessages = await deliverTelegramFinalOutput({
          applicationSessionId: sessionId,
          deliveryIdentity,
          eveSessionId: ctx.session.id,
          eveTurnId: ctx.session.turn.id,
          markdown: deliveryMarkdown,
          sendChunk: async (chunk, ordinal) => {
            // An authored aside is a second thought, so it arrives after a visible typing pause.
            if (chunk.pacing === "aside") {
              await channel.telegram.startTyping();
              await sleep(asidePauseMilliseconds(chunk.text));
            }
            return chunk.format === "plain"
              ? await postTelegramPlainMessageChunk(
                  chunk.text,
                  channel,
                  ordinal === 0 ? replyParameters : undefined,
                )
              : await postTelegramRichMessageChunk(
                  chunk.text,
                  channel.telegram,
                  channel.state,
                  ordinal === 0 ? replyParameters : undefined,
                );
          },
        });
      } catch (error) {
        if (scheduledDelivery) {
          const errorCode = isAppError(error)
            ? error.code
            : "AGENT_TELEGRAM_FINAL_DELIVERY_FAILED";
          console.error(JSON.stringify({
            code: "AGENT_SCHEDULE_FINAL_DELIVERY_FAILED",
            deliveryErrorCode: errorCode,
            errorName: error instanceof Error ? error.name : "UnknownError",
            runId: scheduledDelivery.runId,
          }));
          try {
            await agentScheduleDispatchRepository.failRun(
              sessionId,
              ctx.session.id,
              errorCode,
              new Date(),
            );
          } catch (persistenceError) {
            // Terminal persistence is secondary: log it without replacing the actionable delivery error.
            console.error(JSON.stringify({
              code: "AGENT_SCHEDULE_FINAL_DELIVERY_FAILURE_PERSISTENCE_FAILED",
              deliveryErrorCode: errorCode,
              errorName: persistenceError instanceof Error ? persistenceError.name : "UnknownError",
              runId: scheduledDelivery.runId,
            }));
          }
        }
        throw error;
      }
      await attachTurnReceiptUndo(receipt, channel.telegram.chatId, sentMessages.at(-1)?.messageId ?? null);
      await sendTurnBoard(channel, noticeKey);
      const deliveredAt = new Date();
      const groupId = scheduledDelivery?.groupId ??
        (typeof currentAttributes?.groupId === "string" ? currentAttributes.groupId : null);
      if (scheduledDelivery) {
        const firstMessage = sentMessages[0];
        if (!firstMessage) {
          throw new Error(
            "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING: Telegram не подтвердил доставку результата расписания",
          );
        }
        await agentScheduleDispatchRepository.completeDeliveredRun({
          applicationSessionId: sessionId,
          content: durableText,
          deliveredAt,
          eveSessionId: ctx.session.id,
          familyId: scheduledDelivery.familyId,
          groupId: scheduledDelivery.groupId,
          messageThreadId: scheduledDelivery.messageThreadId,
          ownerUserId: scheduledDelivery.ownerUserId,
          runId: scheduledDelivery.runId,
          scheduledFor: new Date(scheduledDelivery.scheduledFor),
          scope: scheduledDelivery.scope,
          telegramChatId: scheduledDelivery.telegramChatId,
          telegramMessageId: firstMessage.messageId,
          title: scheduledDelivery.title,
        });
      }
      const conversationId = typeof currentAttributes?.telegramConversationId === "string"
        ? currentAttributes.telegramConversationId
        : null;
      if ((conversationId || groupId) && data.finishReason === "stop") {
        const replyToEntryId = typeof currentAttributes?.telegramTimelineEntryId === "string"
          ? currentAttributes.telegramTimelineEntryId
          : null;
        const forumTopicId = scheduledDelivery?.forumTopicId ??
          (typeof currentAttributes?.telegramForumTopicId === "string"
            ? currentAttributes.telegramForumTopicId
            : null);
        // The primary delivery receipt is durable before this secondary conversation projection.
        if (groupId) {
          await telegramGroupJournalRepository.recordAgentResponse({
            applicationSessionId: isScheduledSession(ctx) ? null : sessionId,
            contentText: durableText,
            deliveredAt,
            groupId,
            messageThreadId: forumTopicId,
            replyToEntryId,
            telegramMessageIds: sentMessages.map((sent) => sent.messageId),
          });
        } else if (conversationId) {
          await conversationTimelineRepository.recordAgentResponse({
            applicationSessionId: sessionId,
            contentText: durableText,
            conversationId,
            deliveredAt,
            messageThreadId: null,
            replyToEntryId,
            telegramMessageIds: sentMessages.map((sent) => sent.messageId),
          });
        }
      }
      if (!isScheduledSession(ctx)) {
        await registerTelegramDeliveredMessageRoutes(
          channel,
          ctx,
          sentMessages.map((sent) => sent.messageId),
        );
        // The delivered answer named the records it relied on; only refs shown this turn count.
        await reinforceUsedMemories({
          applicationSessionId: sessionId,
          ctx,
          declared: output.memoryUsedDeclared ?? false,
          memoryRefs: output.memoryUsedRefs ?? [],
        });
      }
    },
    async "session.failed"(data, channel) {
      const failureRepository = {
        async recordSessionFailedByContinuationToken(
          continuationToken: string,
          eveSessionId: string,
        ) {
          return await memoryReviewDispatchRepository.markInteractiveSessionAmbiguous({
            continuationToken,
            diagnosticCode: "AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS",
            eveSessionId,
          }) ?? await sessionRepository.recordSessionFailedByContinuationToken(
            continuationToken,
            eveSessionId,
          );
        },
      };
      await handleTelegramSessionFailure(
        data,
        channel,
        failureRepository,
        agentScheduleDispatchRepository,
      );
    },
    async "actions.requested"(data, channel, ctx) {
      keepTelegramTurnTyping(channel, ctx);
      await recordTelegramTurnSteps(channel, ctx, data.actions, () => deliveryAllowed(ctx));
      await telegramProgressNoticeDeferral.release(
        progressNoticeKey(ctx.session.id, ctx.session.turn.id),
        data.stepIndex,
        data.actions.map((action) => action.kind === "tool-call"
          ? action.toolName
          : action.kind === "load-skill" ? "load_skill" : action.kind),
      );
    },
    async "turn.failed"(data, channel, ctx) {
      stopTelegramTurnTyping(ctx);
      await closeTelegramTurnSteps(ctx);
      telegramProgressNoticeDeferral.forget(progressNoticeKey(ctx.session.id, ctx.session.turn.id));
      // Terminal failure releases the temporary timeline retention after all tool writes have stopped.
      await releaseMemoryTurnSources(ctx);
      const reviewBatchId = await resolveMemoryReviewBatch(ctx);
      let reviewFailureReplayed = false;
      if (reviewBatchId) {
        const terminal = await memoryReviewRepository.failRunning({
          batchId: reviewBatchId,
          diagnosticCode: data.code,
          eveSessionId: ctx.session.id,
          eveTurnId: ctx.session.turn.id,
        });
        reviewFailureReplayed = terminal === "replayed";
      }
      const sessionId = applicationSessionId(ctx);
      const scheduledDelivery = scheduledDeliveryMetadata(ctx);
      // The durable terminal replay still performs cleanup, but never duplicates a user message.
      let notifyFailure = !reviewFailureReplayed;
      if (scheduledDelivery) {
        const failedAt = new Date();
        if (!scheduledTelegramTargetMatches(channel.telegram, scheduledDelivery)) {
          // Never notify a target that was not approved for this run; close it without Telegram I/O.
          console.error(JSON.stringify({
            activeTelegramChatId: channel.telegram.chatId,
            activeTelegramMessageThreadId: channel.telegram.messageThreadId ?? null,
            code: SCHEDULED_TELEGRAM_TARGET_MISMATCH_CODE,
            expectedTelegramChatId: scheduledDelivery.telegramChatId,
            expectedTelegramMessageThreadId: scheduledDelivery.messageThreadId,
            runId: scheduledDelivery.runId,
            turnErrorCode: data.code,
          }));
          await agentScheduleDispatchRepository.failRun(
            sessionId,
            ctx.session.id,
            SCHEDULED_TELEGRAM_TARGET_MISMATCH_CODE,
            failedAt,
          );
          notifyFailure = false;
        } else {
          notifyFailure = await agentScheduleDispatchRepository.failRunForNotification(
            {
              applicationSessionId: sessionId,
              eveSessionId: ctx.session.id,
              familyId: scheduledDelivery.familyId,
              groupId: scheduledDelivery.groupId,
              messageThreadId: scheduledDelivery.messageThreadId,
              ownerUserId: scheduledDelivery.ownerUserId,
              runId: scheduledDelivery.runId,
              scope: scheduledDelivery.scope,
              telegramChatId: scheduledDelivery.telegramChatId,
            },
            data.code,
            failedAt,
          );
        }
      }
      // Terminal diagnostics are private-only even when the failed turn belonged to a shared chat.
      notifyFailure = notifyFailure && shouldNotifyTelegramFailure(channel);
      // A final send that started may already be visible; never append a second failure message.
      const finalDeliveryMayBeVisible = notifyFailure &&
        await telegramFinalDeliveryRepository.shouldSuppressFailureMessage(
          ctx.session.id,
          ctx.session.turn.id,
        );
      if (!finalDeliveryMayBeVisible && notifyFailure) {
        const replyParameters = isScheduledSession(ctx)
          ? undefined
          : telegramTurnReplyParameters(channel.state, ctx);
        const failureMessageId = await postTelegramMessageWithoutContinuationChange(channel, {
          ...(replyParameters === undefined ? {} : { reply_parameters: replyParameters }),
          text: formatTelegramTurnFailure(data),
        });
        if (!isScheduledSession(ctx)) {
          await registerTelegramDeliveredMessageRoutes(channel, ctx, [failureMessageId]);
        }
      }
      if (!reviewBatchId) await sessionRepository.recordTurnFailed(sessionId, ctx.session.id);
      // The next message would fail the same way on the same history, so it starts a new session.
      if (!reviewBatchId && isUnrecoverableHistoryFailure(data)) {
        await sessionRepository.requestRotation(sessionId, "history_unrecoverable");
        console.error(JSON.stringify({
          code: "AGENT_SESSION_HISTORY_UNRECOVERABLE",
          applicationSessionId: sessionId,
          eveSessionId: ctx.session.id,
          eveTurnId: ctx.session.turn.id,
        }));
      }
      await telegramHitlApprovalRepository.clearForEveSession(sessionId, ctx.session.id);
    },
    async "turn.cancelled"(_data, _channel, ctx) {
      stopTelegramTurnTyping(ctx);
      await closeTelegramTurnSteps(ctx);
      // Steering by the next chat message is the most common way a turn ends in a live group. The
      // batch used to wait for the time bound instead, while later turns chained onto a head that
      // would never report, so their finished work stayed unreachable from the lane cursor.
      await releaseMemoryTurnSources(ctx);
      const reviewBatchId = await resolveMemoryReviewBatch(ctx);
      if (reviewBatchId) {
        await memoryReviewRepository.failRunning({
          batchId: reviewBatchId,
          diagnosticCode: "AGENT_MEMORY_REVIEW_TURN_CANCELLED",
          eveSessionId: ctx.session.id,
          eveTurnId: ctx.session.turn.id,
        });
      }
      // A cancelled turn is not a failure and its session keeps serving the replacement turn, so
      // only its own approval rows are released here.
      await telegramHitlApprovalRepository.clearForEveSession(
        applicationSessionId(ctx),
        ctx.session.id,
      );
    },
    async "turn.started"(_data, channel, ctx) {
      keepTelegramTurnTyping(channel, ctx);
      beginTelegramTurnSteps(ctx);
      const sessionId = applicationSessionId(ctx);
      await sessionRepository.bindEveSession(sessionId, ctx.session.id);
      // Which reactions this chat accepts is provider state, so it is refreshed here and read from
      // the database by the prompt resolver. A brand new chat therefore gains the reaction surface
      // from its next turn instead of guessing it now.
      if (!isScheduledSession(ctx)) await refreshTelegramReactionPolicy(channel.telegram);
      // События `chat_member` Eve отбрасывает до приложения, поэтому за составом чата следит
      // счётчик участников: вход и выход он ловит в пределах минуты, а события дали бы только
      // скорость. Расхождение снимает разрешение, и дальше всё уже написанное срабатывает само.
      await watchTelegramAudience(channel, ctx);
      const reviewBatchId = memoryReviewBatchId(ctx);
      if (reviewBatchId) {
        await memoryReviewRepository.bindEveTurn({
          applicationSessionId: sessionId,
          batchId: reviewBatchId,
          eveSessionId: ctx.session.id,
          eveTurnId: ctx.session.turn.id,
        });
      }
      // This immutable snapshot survives every later model/tool/HITL step in the same durable turn.
      await bindMemoryTurnSources(ctx);
      const attributes = ctx.session.auth.current?.attributes;
      const timelineSequence = attributes?.telegramTimelineSequence;
      if (typeof timelineSequence === "string") {
        await groupTimelineCursorRepository.advance(
          sessionId,
          ctx.session.id,
          timelineSequence,
        );
      }
      const proactiveDeliveryCursor = attributes?.proactiveDeliveryCursor;
      if (typeof proactiveDeliveryCursor === "string") {
        await proactiveDeliveryRepository.advanceSessionCursor(
          sessionId,
          proactiveDeliveryCursor,
        );
      }
    },
    async "turn.completed"(_data, channel, ctx) {
      stopTelegramTurnTyping(ctx);
      await closeTelegramTurnSteps(ctx);
      // Text still held here was the answer: the model never wrote again after its quiet tools.
      const noticeKey = progressNoticeKey(ctx.session.id, ctx.session.turn.id);
      await telegramProgressNoticeDeferral.flush(noticeKey);
      telegramProgressNoticeDeferral.forget(noticeKey);
      const sessionId = applicationSessionId(ctx);
      const awaitingApproval = await sessionRepository.hasPendingOperation(sessionId, ctx.session.id);
      const reviewBatchId = await resolveMemoryReviewBatch(ctx);
      if (!awaitingApproval) {
        // Completion verifies review evidence before release; a parked HITL turn retains its source set.
        if (reviewBatchId) {
          await memoryReviewRepository.completeBatch({
            batchId: reviewBatchId,
            completedAt: new Date(),
            eveSessionId: ctx.session.id,
            eveTurnId: ctx.session.turn.id,
          });
        }
        await releaseMemoryTurnSources(ctx);
      }
      if (isScheduledSession(ctx) && !awaitingApproval) {
        // Successful scheduled runs are completed atomically with Telegram delivery above.
        await agentScheduleDispatchRepository.failRun(
          sessionId,
          ctx.session.id,
          "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING",
          new Date(),
        );
      }
      if (!reviewBatchId) {
        await sessionRepository.recordTurnCompleted(sessionId, ctx.session.id, awaitingApproval);
      }
      if (!awaitingApproval) {
        await telegramHitlApprovalRepository.clearForEveSession(sessionId, ctx.session.id);
      }
      // After the answer, a step of «Знакомство» done for the first time brings the next step card (`onboarding-quest/`).
      const questActor = awaitingApproval || reviewBatchId ? null : questTurnActor(ctx);
      if (questActor !== null) await advanceQuestAfterSuccess(questActor);
    },
    async "authorization.required"(_data, _channel, ctx) {
      stopTelegramTurnTyping(ctx);
      await closeTelegramTurnSteps(ctx);
      if (isTelegramChannelSession(ctx.session.auth)) {
        throw new AppError(
          "AGENT_TELEGRAM_CHANNEL_APPROVAL_FORBIDDEN",
          "Сообщение от имени канала не может подтверждать действия. Напишите от личного аккаунта",
        );
      }
      const sessionId = applicationSessionId(ctx);
      const auth = ctx.session.auth.current;
      const telegramUserId = auth?.attributes.telegramUserId;
      await sessionRepository.parkSession({
        applicationSessionId: sessionId,
        pendingRequestId: null,
        requesterTelegramUserId: typeof telegramUserId === "string" ? telegramUserId : null,
        requesterUserId: auth && UUID_PATTERN.test(auth.principalId) ? auth.principalId : null,
      });
    },
    async "authorization.completed"(_data, _channel, ctx) {
      await sessionRepository.resumePendingSession(applicationSessionId(ctx), ctx.session.id);
    },
  },
  onDrain: handleTelegramDurableIngress.drain,
  onGuestUpdate: handleTelegramDurableIngress.guest,
  onChatJoinRequest: handleTelegramDurableIngress.joinRequest,
  onHitlCallbackQuery: authorizeTelegramHitlCallback,
  onMessage: handleTelegramMessage,
  onVerifiedUpdate: handleTelegramDurableIngress,
  // The application persists authorized files before dispatch. The primary model receives only
  // trusted workspace paths and invokes the dedicated vision model when image analysis is needed.
  uploadPolicy: TELEGRAM_EVE_UPLOAD_POLICY,
});
