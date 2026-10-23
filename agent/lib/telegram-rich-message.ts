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
 * - `withoutRichMediaBlocks`: a stored update whose file the chat may not read keeps the text
 *   (captions become paragraphs) and no file reference, so nothing can lift it again.
 *
 * Key constructs:
 * - Bot API 10.1 (June 2026) delivers rich messages in `message.rich_message`; `message.text` is
 *   absent or holds only a plain fallback. Eve 0.40.0 parses `text` and `caption` alone, so a
 *   collapsed "Полный ответ" from another bot arrived as an empty message. Block order is kept;
 *   a details block contributes its summary and its nested blocks; rich text given as parts
 *   (strings and link entities) is joined.
 */
import type { TelegramUpdate } from "eve/channels/telegram";

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

const RICH_MEDIA_BLOCKS = new Set(["animation", "audio", "document", "photo", "video", "voice_note"]);

export type RichMessageMedia =
  | { kind: "document"; document: JsonRecord }
  | { kind: "photo"; sizes: JsonRecord[] };

/** Container blocks nest further blocks: a details block, quotations, list items (Bot API 10.1). */
const NESTED_BLOCK_KEYS = ["blocks", "items"] as const;

/** Every block of a rich message, top level and nested, in reading order. */
function allBlocks(blocks: unknown): JsonRecord[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((entry) => {
    const block = record(entry);
    if (block === null) return [];
    return [block, ...NESTED_BLOCK_KEYS.flatMap((key) => allBlocks(block[key]))];
  });
}

function isMediaBlock(block: JsonRecord): boolean {
  return typeof block.type === "string" && RICH_MEDIA_BLOCKS.has(block.type);
}

function mediaBlocks(raw: JsonRecord): JsonRecord[] | null {
  const blocks = record(raw.rich_message)?.blocks;
  if (!Array.isArray(blocks)) return null;
  return allBlocks(blocks).filter(isMediaBlock);
}

/**
 * The one photo or document of a rich message that embeds exactly one file. A voice, a video, an
 * audio or an animation block is never lifted: Eve has no reader for it and the chat keeps the text.
 */
export function richMessageMedia(raw: JsonRecord): RichMessageMedia | null {
  const media = mediaBlocks(raw);
  if (media === null || media.length !== 1) return null;
  const block = media[0]!;
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

function largestSize(sizes: readonly JsonRecord[]): JsonRecord {
  const area = (size: JsonRecord) => (typeof size.width === "number" ? size.width : 0) * (typeof size.height === "number" ? size.height : 0);
  return sizes.reduce((best, size) => (area(size) > area(best) ? size : best), sizes[0]!);
}

/**
 * A channel post forwarded into a discussion group (23 October 2026, «Дизраптим») is one photo
 * block and paragraphs; Eve parses neither. The file becomes what an ordinary photo or document
 * message is, so the external media gate and the readers decide about it with their usual rules
 * (a picture by `inspect_workspace_image`, a text file by `import_telegram_attachment`), and the
 * text stands on its own whatever that decision is.
 */
export function normalizeRichMessage(update: TelegramUpdate): TelegramUpdate {
  const withText = withRichMessageText(update);
  if (withText.kind !== "message") return withText;
  const raw = withText.message.raw;
  if (raw.photo !== undefined || raw.document !== undefined || withText.message.attachments.length > 0) return withText;
  const media = richMessageMedia(raw);
  if (media === null) return withText;
  if (media.kind === "photo") {
    const best = largestSize(media.sizes);
    return {
      ...withText,
      message: {
        ...withText.message,
        attachments: [{
          fileId: best.file_id as string,
          ...(typeof best.file_unique_id === "string" ? { fileUniqueId: best.file_unique_id } : {}),
          ...(typeof best.height === "number" ? { height: best.height } : {}),
          kind: "photo",
          mediaType: "image/jpeg",
          ...(typeof best.file_size === "number" ? { size: best.file_size } : {}),
          ...(typeof best.width === "number" ? { width: best.width } : {}),
        }],
        raw: { ...raw, photo: media.sizes },
      },
    };
  }
  const document = media.document;
  return {
    ...withText,
    message: {
      ...withText.message,
      attachments: [{
        fileId: document.file_id as string,
        ...(typeof document.file_name === "string" ? { fileName: document.file_name } : {}),
        ...(typeof document.file_unique_id === "string" ? { fileUniqueId: document.file_unique_id } : {}),
        kind: "document",
        ...(typeof document.mime_type === "string" ? { mediaType: document.mime_type } : {}),
        ...(typeof document.file_size === "number" ? { size: document.file_size } : {}),
      }],
      raw: { ...raw, document },
    },
  };
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

/**
 * The stored shape of a rich post whose file the chat may not read: every media block becomes a
 * paragraph with its caption, or disappears. The text still reaches the chat, and no later read
 * finds a file to lift, download or forward.
 */
export function withoutRichMediaBlocks<T extends JsonRecord>(payload: T): T {
  const message = record(payload.message);
  const rich = record(message?.rich_message);
  if (message === null || rich === null || !Array.isArray(rich.blocks)) return payload;
  return { ...payload, message: { ...message, rich_message: { ...rich, blocks: stripMediaBlocks(rich.blocks) } } };
}

function stripMediaBlocks(blocks: readonly unknown[]): unknown[] {
  return blocks.flatMap((entry) => {
    const block = record(entry);
    if (block === null) return [entry];
    if (isMediaBlock(block)) {
      const caption = richText(record(block.caption)?.text ?? block.caption);
      return caption ? [{ text: caption, type: "paragraph" }] : [];
    }
    const nested = Object.fromEntries(NESTED_BLOCK_KEYS.filter((key) => Array.isArray(block[key])).map((key) => [key, stripMediaBlocks(block[key] as unknown[])]));
    return [{ ...block, ...nested }];
  });
}
