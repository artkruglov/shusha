/**
 * Interim Telegram progress notice for a long interactive turn.
 *
 * Export:
 * - `deliverTelegramProgressNotice`: sends model-authored pre-tool text at most once per step and returns
 *   the id of its last message (buttons go under it), or null when nothing was sent.
 *
 * Key construct:
 * - The notice is cosmetic and its turn is still working, so a failed send is logged and the turn
 *   continues; the durable claim happens first, so a replay never repeats a delivered notice.
 */
import { splitTelegramMessageText, type TelegramEventContext } from "eve/channels/telegram";

import { isAppError } from "./app-error.js";
import { postTelegramPlainMessageChunk } from "./telegram-plain-messages.js";
import { telegramProgressNoticeRepository } from "./telegram-progress-notice-repository.js";

export async function deliverTelegramProgressNotice(input: {
  applicationSessionId: string;
  channel: TelegramEventContext;
  eveSessionId: string;
  eveTurnId: string;
  message: string;
  stepIndex: number;
}): Promise<string | null> {
  const claim = await telegramProgressNoticeRepository.claim({
    applicationSessionId: input.applicationSessionId,
    eveSessionId: input.eveSessionId,
    eveTurnId: input.eveTurnId,
    stepIndex: input.stepIndex,
  });
  if (!claim) return null;

  try {
    let firstMessageId: string | null = null;
    let lastMessageId: string | null = null;
    for (const chunk of splitTelegramMessageText(input.message)) {
      const sent = await postTelegramPlainMessageChunk(chunk, input.channel);
      firstMessageId ??= sent.messageId;
      lastMessageId = sent.messageId;
    }
    if (firstMessageId !== null) {
      await telegramProgressNoticeRepository.confirm(claim.noticeId, firstMessageId);
    }
    return lastMessageId;
  } catch (error) {
    // The answer this notice announces is still being produced: never fail the turn over a notice.
    console.error(JSON.stringify({
      code: "AGENT_TELEGRAM_PROGRESS_NOTICE_FAILED",
      errorCode: isAppError(error) ? error.code : null,
      errorName: error instanceof Error ? error.name : "UnknownError",
      stepIndex: input.stepIndex,
    }));
    return null;
  }
}
