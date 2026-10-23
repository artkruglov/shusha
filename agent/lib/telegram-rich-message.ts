/**
 * Plain text of a Bot API rich message.
 *
 * Exports:
 * - `richMessagePlainText`: flattens `rich_message.blocks` of a raw Telegram message into text.
 * - `withRichMessageText`: fills an inbound update's empty `text` from its rich blocks.
 * - `richMessageMedia`: the one photo or document a rich message carries, in Telegram's shape.
 * - `normalizeRichMessage`: text from blocks plus that file lifted into `raw.photo` or
 *   `raw.document` and one Eve attachment, so the media gate, the vision path and the attachment
 *   import see a channel post exactly like an ordinary photo or file message.
 * - `richMediaIsLifted`: the raw message carries exactly the file lifted from its blocks.
 * - `richMessageBesidesLifted`: `rich_message` without the lifted block, to look for other files.
 * - `containsTelegramFileReference`: whether a subtree names a Telegram file at all.
 * - `withoutRichMediaBlocks`: a stored update whose file the chat may not read keeps the text
 *   (captions become paragraphs) and no file reference, so nothing can lift it again. Any block
 *   whose own fields name a file is cut, not only the known media types (fail closed).
 *
 * Key constructs:
 * - Bot API 10.1 (June 2026) delivers rich messages in `message.rich_message`; `message.text` is
 *   absent or holds only a plain fallback. Eve 0.40.0 parses `text` and `caption` alone, so a
 *   collapsed "Полный ответ" from another bot arrived as an empty message. Block order is kept;
 *   a details block contributes its summary and its nested blocks; rich text given as parts
 *   (strings and link entities) is joined.
 */
import { parseTelegramUpdate, type TelegramUpdate } from "eve/channels/telegram";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

/**
 * RichText arrives as a string, as `{ text, entities }`, or as an array of parts: plain strings
 * mixed with typed entities such as `{ type: "url", text, url }`. Only the readable text matters,
 * so parts are joined in order; an array that was ignored here dropped every paragraph with a link.
 */
function richText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(richText).join("");
  const text = record(value)?.text;
  return typeof text === "string" || Array.isArray(text) ? richText(text) : "";
}

function blocksText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => blockText(record(block)));
}

function blockText(block: JsonRecord | null): string[] {
  if (!block) return [];
  switch (block.type) {
    case "paragraph":
    case "section_heading":
    case "preformatted":
    case "footer":
    case "thinking":
    case "mathematical_expression": {
      const text = richText(block.text);
      return text ? [text] : [];
    }
    case "details": {
      const summary = richText(block.summary ?? block.header);
      return [...(summary ? [summary] : []), ...blocksText(block.blocks)];
    }
    // Bot API 10.1 names a quotation block `blockquote`; the long names are kept for the earlier shape.
    case "blockquote":
    case "expandable_blockquote":
    case "block_quotation":
    case "expandable_block_quotation":
      return blocksText(block.blocks);
    case "pull_quotation": {
      const text = richText(block.text);
      return [...(text ? [text] : []), ...blocksText(block.blocks)];
    }
    case "list":
      return Array.isArray(block.items)
        ? block.items.flatMap((item) => {
          const entry = record(item);
          const text = richText(entry?.text);
          return text ? [text] : blocksText(entry?.blocks);
        })
        : [];
    case "table":
      return Array.isArray(block.rows)
        ? block.rows.flatMap((row) => {
          const cells = record(row)?.cells;
          return Array.isArray(cells)
            ? [cells.map((cell) => richText(record(cell)?.text ?? cell)).filter(Boolean).join(" | ")]
            : [];
        }).filter(Boolean)
        : [];
    case "animation":
    case "audio":
    case "photo":
    case "video":
    case "voice_note":
    case "document": {
      const caption = richText(record(block.caption)?.text ?? block.caption);
      return caption ? [caption] : [];
    }
    default:
      return [];
  }
}

export function richMessagePlainText(raw: JsonRecord): string | null {
  const rich = record(raw.rich_message);
  if (!rich) return null;
  const fromBlocks = blocksText(rich.blocks).map((part) => part.trim()).filter(Boolean).join("\n\n");
  if (fromBlocks) return fromBlocks;
  return typeof rich.text === "string" && rich.text.trim() ? rich.text.trim() : null;
}

export function withRichMessageText(update: TelegramUpdate): TelegramUpdate {
  if (update.kind !== "message" || update.message.text.trim()) return update;
  const text = richMessagePlainText(update.message.raw);
  return text === null ? update : { ...update, message: { ...update.message, text } };
}


export type RichMessageMedia =
  | { kind: "document"; document: JsonRecord }
  | { kind: "photo"; sizes: JsonRecord[] };

/** Container blocks nest further blocks: a details block, quotations, list items (Bot API 10.1). */
const NESTED_BLOCK_KEYS = ["blocks", "items"] as const;

/** True when any object in the subtree names a Telegram file (`file_id`), however deep. */
export function containsTelegramFileReference(value: unknown): boolean {
  // Conditional structures can be text-only, so search only their own subtree for actual files.
  const pending = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const entry = current as JsonRecord;
    if (typeof entry.file_id === "string" && entry.file_id.length > 0) return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/**
 * A block carries a file when its own fields (its nested blocks aside) name one, whatever its
 * type: a block type Telegram adds later with a file inside fails closed instead of slipping by.
 */
function carriesFile(block: JsonRecord): boolean {
  return Object.entries(block).some(([key, value]) =>
    !((NESTED_BLOCK_KEYS as readonly string[]).includes(key) && Array.isArray(value)) &&
    containsTelegramFileReference(value));
}

/** Every block of a rich message, top level and nested, in reading order. */
function allBlocks(blocks: unknown): JsonRecord[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((entry) => {
    const block = record(entry);
    if (block === null) return [];
    return [block, ...NESTED_BLOCK_KEYS.flatMap((key) => allBlocks(block[key]))];
  });
}

function fileBlocks(raw: JsonRecord): JsonRecord[] | null {
  const blocks = record(raw.rich_message)?.blocks;
  if (!Array.isArray(blocks)) return null;
  return allBlocks(blocks).filter(carriesFile);
}

/**
 * The one photo or document of a rich message that embeds exactly one file-bearing block. A voice,
 * a video, an audio, an animation or an unknown block is never lifted: the chat keeps the text.
 */
export function richMessageMedia(raw: JsonRecord): RichMessageMedia | null {
  const files = fileBlocks(raw);
  if (files === null || files.length !== 1) return null;
  const block = files[0]!;
  if (block.type === "photo" && Array.isArray(block.photo)) {
    const sizes = block.photo.map(record);
    if (sizes.length === 0 || sizes.some((size) => size === null || typeof size.file_id !== "string" || size.file_id.length === 0)) return null;
    return { kind: "photo", sizes: sizes as JsonRecord[] };
  }
  if (block.type === "document") {
    const document = record(block.document);
    if (document === null || typeof document.file_id !== "string" || document.file_id.length === 0) return null;
    return { document, kind: "document" };
  }
  return null;
}

/**
 * A channel post forwarded into a discussion group (23 October 2026, a discussion group) is one photo
 * block and paragraphs; Eve parses neither. The file becomes what an ordinary photo or document
 * message is, and Eve's own parser builds the attachment (largest photo by size, `photo.jpg`), so
 * the external media gate and the readers decide about it with their usual rules and the text
 * stands on its own whatever that decision is.
 */
export function normalizeRichMessage(update: TelegramUpdate): TelegramUpdate {
  const withText = withRichMessageText(update);
  if (withText.kind !== "message") return withText;
  const message = withText.message;
  const raw = message.raw;
  if (raw.photo !== undefined || raw.document !== undefined || message.attachments.length > 0) return withText;
  const media = richMessageMedia(raw);
  if (media === null) return withText;
  const file = media.kind === "photo" ? { photo: media.sizes } : { document: media.document };
  const parsed = parseTelegramUpdate({
    message: { chat: { id: message.chat.id, type: message.chat.type }, message_id: message.messageId, ...file },
    update_id: 0,
  });
  if (parsed?.kind !== "message" || parsed.message.attachments.length !== 1) return withText;
  return { ...withText, message: { ...message, attachments: parsed.message.attachments, raw: { ...raw, ...file } } };
}

/** True when `raw.photo` or `raw.document` is exactly the file lifted out of the rich blocks. */
export function richMediaIsLifted(raw: JsonRecord): boolean {
  const lifted = richMessageMedia(raw);
  if (lifted === null) return false;
  if (lifted.kind === "document") {
    return raw.photo === undefined && record(raw.document)?.file_id === lifted.document.file_id;
  }
  if (raw.document !== undefined || !Array.isArray(raw.photo)) return false;
  const ids = (list: readonly unknown[]) => list.map((size) => record(size)?.file_id).filter((id): id is string => typeof id === "string").sort().join("\u0000");
  return ids(lifted.sizes) === ids(raw.photo);
}

/** Blocks with `replace(block)` in place of each block it answers for; the rest keep their nesting. */
function rewriteBlocks(blocks: readonly unknown[], replace: (block: JsonRecord) => unknown[] | null): unknown[] {
  return blocks.flatMap((entry) => {
    const block = record(entry);
    if (block === null) return [entry];
    const replaced = replace(block);
    if (replaced !== null) return replaced;
    const nested = Object.fromEntries(NESTED_BLOCK_KEYS.filter((key) => Array.isArray(block[key]))
      .map((key) => [key, rewriteBlocks(block[key] as unknown[], replace)]));
    return [{ ...block, ...nested }];
  });
}

/** `rich_message` without the block that was lifted: what else of the post names a file. */
export function richMessageBesidesLifted(raw: JsonRecord): unknown {
  const rich = record(raw.rich_message);
  const files = fileBlocks(raw);
  if (rich === null || files === null || files.length !== 1 || !richMediaIsLifted(raw)) return raw.rich_message;
  const lifted = files[0];
  return { ...rich, blocks: rewriteBlocks(rich.blocks as unknown[], (block) => block === lifted ? [] : null) };
}

/** The readable text of a block that is cut out: its own reading, else its text or caption. */
function cutBlockText(block: JsonRecord): string {
  const parts = blockText(block).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 0) return parts.join("\n\n");
  return (richText(block.text) || richText(record(block.caption)?.text ?? block.caption)).trim();
}

/**
 * The stored shape of a rich post whose file the chat may not read: every block that carries a
 * file, of any type, becomes a paragraph with its text or caption, or disappears, and a field of
 * `rich_message` outside the blocks that names a file is dropped. The text still reaches the chat,
 * and no later read finds a file to lift, download or forward.
 */
export function withoutRichMediaBlocks<T extends JsonRecord>(payload: T): T {
  const message = record(payload.message);
  const rich = record(message?.rich_message);
  if (message === null || rich === null) return payload;
  const kept = Object.fromEntries(Object.entries(rich).filter(([key, value]) =>
    key === "blocks" || !containsTelegramFileReference(value)));
  if (Array.isArray(rich.blocks)) {
    kept.blocks = rewriteBlocks(rich.blocks, (block) => {
      if (!carriesFile(block)) return null;
      const text = cutBlockText(block);
      return text ? [{ text, type: "paragraph" }] : [];
    });
  } else if (containsTelegramFileReference(rich.blocks)) {
    delete kept.blocks;
  }
  return { ...payload, message: { ...message, rich_message: kept } };
}
