/**
 * Durable ingress decisions for Bot API rich posts (a channel post forwarded into a group).
 *
 * The rich-post reading comes from ilkruglov's PR #17 in artkruglov/shusha («Rich-посты каналов
 * читаются как обычные сообщения»); ported here with a fail-closed file check, reply targets
 * normalised the same way, and a redelivery comparison that is symmetric in the stripped form.
 *
 * Exports:
 * - `RichIngressDecision`, `prepareRichIngress`: the normalised update, its media kind for the
 *   gate, and whether its text may go on when the gate refuses the one lifted file.
 * - `richIngressPayload`: what is stored for the update, or null when nothing may be stored.
 * - `sameTelegramIngressPayload`: whether a redelivered payload is the stored one, either side
 *   possibly with its rich files cut out.
 */
import { isDeepStrictEqual } from "node:util";

import type { TelegramUpdate } from "eve/channels/telegram";

import {
  classifyTelegramInboundMedia,
  hasTelegramRawMediaBesidesLifted,
  type TelegramInboundMediaKind,
} from "./telegram-message-policy.js";
import {
  normalizeRichMessage,
  richMediaIsLifted,
  richMessagePlainText,
  withoutRichMediaBlocks,
} from "./telegram-rich-message.js";

export interface RichIngressDecision {
  mediaKind: TelegramInboundMediaKind;
  /** The update has text of its own and its only media is the lifted file. */
  textFallback: boolean;
  update: TelegramUpdate;
}

/**
 * A rich message is read as text with its one photo or document lifted, so a channel post meets
 * the same media gate as a photo or file message instead of being refused as a whole. Only that
 * lifted file may be refused while its text goes on: any other media next to it (a voice field,
 * a second file, a file in a block of any other type) keeps the full refusal.
 */
export function prepareRichIngress(incoming: TelegramUpdate): RichIngressDecision {
  const update = normalizeRichMessage(incoming);
  if (update.kind !== "message") return { mediaKind: "none", textFallback: false, update };
  const raw = update.message.raw;
  return {
    mediaKind: classifyTelegramInboundMedia(update.message),
    textFallback: update.message.attachments.length === 1 && richMediaIsLifted(raw) &&
      !hasTelegramRawMediaBesidesLifted(raw) && richMessagePlainText(raw) !== null,
    update,
  };
}

/**
 * The payload to store. Refused media without text stores nothing. A refused lifted file and a
 * rich post that lifted nothing (two files, a video, an unknown file block) store the text with
 * every file reference of the post cut out, so no later read can lift, download or forward it.
 */
export function richIngressPayload(
  raw: Record<string, unknown>,
  decision: Pick<RichIngressDecision, "mediaKind" | "textFallback" | "update">,
  mediaAccepted: boolean,
): Record<string, unknown> | null {
  if (decision.update.kind !== "message") return raw;
  if (decision.mediaKind === "none") return withoutRichMediaBlocks(raw);
  if (mediaAccepted) return raw;
  return decision.textFallback ? withoutRichMediaBlocks(raw) : null;
}

/**
 * Telegram redelivers an update with the file still inside, while the stored copy may lack it
 * (the file was refused) or keep it (it was accepted, and the grant was removed before the
 * redelivery cut it). The same update is a duplicate when the two are equal or one of them is the
 * other with its rich files cut out; the check runs both ways, so the order of grant changes does
 * not matter. Two different files that were both kept are still a conflict, as is any other
 * difference. Payloads without `rich_message` compare unchanged.
 */
export function sameTelegramIngressPayload(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
): boolean {
  // The stored side went through jsonb; the incoming side is brought to the same JSON values.
  const storedJson = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
  const incomingJson = JSON.parse(JSON.stringify(incoming)) as Record<string, unknown>;
  return isDeepStrictEqual(storedJson, incomingJson) ||
    isDeepStrictEqual(storedJson, withoutRichMediaBlocks(incomingJson)) ||
    isDeepStrictEqual(withoutRichMediaBlocks(storedJson), incomingJson);
}
