/**
 * Rich-post durable ingress tests (cases from ilkruglov's PR #17 in artkruglov/shusha, plus the
 * review fixes).
 *
 * Constructs covered:
 * - A lifted photo or document meets the media gate; a refused file keeps the post's text.
 * - Media besides the lifted file, of any block type or field, keeps the full refusal.
 * - A rich post that lifted nothing is stored as text without any file reference.
 * - An unknown block type that names a file fails closed: refused alone, stripped next to text.
 * - Redelivery compares the stored and the incoming payload both ways in the stripped form.
 */
import type { TelegramVerifiedUpdateContext } from "eve/channels/telegram";
import { parseTelegramUpdate } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import type { TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import { hasTelegramRawMediaBesidesLifted } from "./telegram-message-policy.js";
import { prepareRichIngress, sameTelegramIngressPayload } from "./telegram-rich-ingress.js";

function repository() {
  return {
    acceptMedia: vi.fn().mockResolvedValue(true),
    beginDispatch: vi.fn(),
    beginVoiceTranscription: vi.fn().mockResolvedValue("started"),
    claimFollowing: vi.fn().mockResolvedValue([]),
    claimNext: vi.fn().mockResolvedValue(null),
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
    saveVoiceTranscript: vi.fn(),
    sessionEventStreamCursor: vi.fn().mockResolvedValue(0),
  } satisfies TelegramIngressRepository;
}

/** A channel post as Telegram delivers it into the discussion supergroup. */
function channelPost(updateId: number, richMessage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    message: {
      chat: { id: -1_003_576_522_523, type: "supergroup" },
      date: 1_792_736_474,
      from: { first_name: "Telegram", id: 777_000, is_bot: false },
      message_id: updateId - 85_024_802,
      rich_message: richMessage,
      sender_chat: { id: -1_001_000_000_002, title: "Канал про агентов", type: "channel" },
      ...extra,
    },
    update_id: updateId,
  };
}

/** Runs one verified update through the ingress with the gate answering `accepted`. */
async function ingest(raw: Record<string, unknown>, accepted: boolean) {
  const storage = repository();
  const acceptMedia = vi.fn().mockResolvedValue(accepted);
  const update = parseTelegramUpdate(raw);
  if (!update || update.kind !== "message") throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID");
  const handle = createTelegramDurableIngress({
    acceptMedia,
    authorizeVoice: vi.fn(),
    botUsername: "osinara_bot",
    handleGuestMessage: vi.fn(),
    handleGuestReminderCallback: vi.fn().mockResolvedValue(false),
    handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
    leaseMilliseconds: 60_000,
    repository: storage,
    requestSessionRotation: vi.fn(),
    transcribeVoice: vi.fn(),
  });
  const response = await handle({ dispatch: vi.fn(), raw, update, waitUntil: vi.fn() } as unknown as TelegramVerifiedUpdateContext);
  expect(response.status).toBe(200);
  const stored = storage.enqueue.mock.calls[0]?.[0] as { payload: { message: { rich_message: { blocks: unknown[] } } }; updateId: string } | undefined;
  return { acceptMedia, enqueue: storage.enqueue, stored };
}

const photoSizes = [
  { file_id: "p-small", file_size: 2_395, file_unique_id: "u1", height: 89, width: 90 },
  { file_id: "p-large", file_size: 90_000, file_unique_id: "u1", height: 1_280, width: 1_280 },
];

describe("rich-post durable ingress", () => {
  // 23 October 2026: a channel post forwarded into a discussion group (one photo block, paragraphs) was
  // refused as external media and its text never reached the chat; 56 replies pointed at nothing.
  it("keeps the text of a rich post whose photo the external group may not read", async () => {
    const raw = channelPost(85_121_293, { blocks: [{ photo: photoSizes, type: "photo" }, { text: "пост про эвалы", type: "paragraph" }] });

    const { acceptMedia, stored } = await ingest(raw, false);

    // The lifted photo met the gate as a native photo, built by Eve's parser.
    expect(acceptMedia).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ fileId: "p-large", fileName: "photo.jpg", kind: "photo", size: 90_000 })],
      text: "пост про эвалы",
    }), "85121293", "native_photo", true);
    expect(stored?.updateId).toBe("85121293");
    expect(stored?.payload.message.rich_message.blocks).toEqual([{ text: "пост про эвалы", type: "paragraph" }]);
    expect(JSON.stringify(stored?.payload)).not.toContain("file_id");
  });

  it("refuses a rich post with text when its media is not the lifted photo alone", async () => {
    const raw = channelPost(85_121_295, { blocks: [{ type: "video", video: { file_id: "v1" } }, { text: "пост с видео", type: "paragraph" }] },
      { voice: { duration: 3, file_id: "voice-1", mime_type: "audio/ogg" } });

    const { acceptMedia, enqueue } = await ingest(raw, false);

    expect(acceptMedia).toHaveBeenCalledWith(expect.anything(), "85121295", "unsupported_media", false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("meets the gate with a lifted rich document and keeps the text when the file is refused", async () => {
    const document = { file_id: "d1", file_name: "правила.md", file_size: 512, file_unique_id: "ud", mime_type: "text/markdown" };
    const raw = channelPost(85_121_296, { blocks: [{ document, type: "document" }, { text: "правила группы в файле", type: "paragraph" }] });

    const { acceptMedia, stored } = await ingest(raw, false);

    expect(acceptMedia).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ fileId: "d1", fileName: "правила.md", kind: "document" })],
      text: "правила группы в файле",
    }), "85121296", "text_document_candidate", true);
    expect(stored?.payload.message.rich_message.blocks).toEqual([{ text: "правила группы в файле", type: "paragraph" }]);
    expect(JSON.stringify(stored?.payload)).not.toContain("d1");
  });

  it("stores a rich post that lifted nothing as text without its file references", async () => {
    const raw = channelPost(85_121_297, { blocks: [
      { type: "video", video: { file_id: "v-1" } },
      { caption: { text: "кадр" }, photo: [{ file_id: "p-1" }], type: "photo" },
      { text: "два вложения", type: "paragraph" },
    ] });

    const { acceptMedia, stored } = await ingest(raw, true);

    expect(acceptMedia).not.toHaveBeenCalled();
    expect(stored?.payload.message.rich_message.blocks).toEqual([{ text: "кадр", type: "paragraph" }, { text: "два вложения", type: "paragraph" }]);
    expect(JSON.stringify(stored?.payload)).not.toContain("file_id");
  });

  it("stores an accepted rich post with its file intact", async () => {
    const raw = channelPost(85_121_294, { blocks: [{ photo: [{ file_id: "p1", file_unique_id: "u1", height: 640, width: 640 }], type: "photo" }, { text: "с правом", type: "paragraph" }] });

    const { acceptMedia, enqueue } = await ingest(raw, true);

    expect(acceptMedia).toHaveBeenCalledWith(expect.anything(), "85121294", "native_photo", true);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ payload: raw }));
  });
});

// Review of PR #17: only the known media types were cut, so a block type Telegram adds later with
// a file inside stayed in the stored update. Any block whose own fields name a file is media now.
describe("rich-post ingress fails closed on unknown file blocks", () => {
  const unknownBlock = { slideshow: { items: [{ file_id: "s-1", file_unique_id: "us" }] }, type: "slideshow" };

  it("refuses an unknown file block without text in an external group without a grant", async () => {
    const raw = channelPost(85_121_300, { blocks: [unknownBlock] });

    const { acceptMedia, enqueue } = await ingest(raw, false);

    expect(acceptMedia).toHaveBeenCalledWith(expect.anything(), "85121300", "unsupported_media", false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("stores the text of a post with an unknown file block and cuts the block out", async () => {
    const raw = channelPost(85_121_301, { blocks: [{ ...unknownBlock, caption: "слайды" }, { text: "текст поста", type: "paragraph" }] });

    const { acceptMedia, stored } = await ingest(raw, false);

    expect(acceptMedia).not.toHaveBeenCalled();
    expect(stored?.payload.message.rich_message.blocks).toEqual([{ text: "слайды", type: "paragraph" }, { text: "текст поста", type: "paragraph" }]);
    expect(JSON.stringify(stored?.payload)).not.toContain("s-1");
  });

  it("lifts no photo next to an unknown file block and stores the text alone", async () => {
    const raw = channelPost(85_121_302, { blocks: [{ photo: photoSizes, type: "photo" }, unknownBlock, { text: "текст", type: "paragraph" }] });

    const { acceptMedia, stored } = await ingest(raw, true);

    expect(acceptMedia).not.toHaveBeenCalled();
    expect(stored?.payload.message.rich_message.blocks).toEqual([{ text: "текст", type: "paragraph" }]);
    expect(JSON.stringify(stored?.payload)).not.toContain("file_id");
  });

  it("refuses the whole post when a file sits in rich_message outside the blocks", async () => {
    const raw = channelPost(85_121_303, { blocks: [{ photo: photoSizes, type: "photo" }, { text: "текст", type: "paragraph" }], cover: { file_id: "c-1" } });

    const { acceptMedia, enqueue } = await ingest(raw, false);

    expect(acceptMedia).toHaveBeenCalledWith(expect.anything(), "85121303", "unsupported_media", false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("counts every file of the post besides the lifted one", () => {
    const lifted = (blocks: unknown[], rich: Record<string, unknown> = {}) => {
      const decision = prepareRichIngress(parseTelegramUpdate(channelPost(1, { blocks, ...rich }))!);
      if (decision.update.kind !== "message") throw new Error("message expected");
      return decision.update.message.raw;
    };
    const photo = { photo: photoSizes, type: "photo" };
    expect(hasTelegramRawMediaBesidesLifted(lifted([photo, { text: "т", type: "paragraph" }]))).toBe(false);
    expect(hasTelegramRawMediaBesidesLifted(lifted([photo], { cover: { file_id: "c-1" } }))).toBe(true);
    expect(hasTelegramRawMediaBesidesLifted(lifted([{ ...photo, blocks: [unknownBlock] }]))).toBe(true);
    expect(hasTelegramRawMediaBesidesLifted(lifted([photo, unknownBlock]))).toBe(true);
  });
});

describe("sameTelegramIngressPayload", () => {
  const withFile = channelPost(85_121_310, { blocks: [{ photo: photoSizes, type: "photo" }, { text: "пост", type: "paragraph" }] });
  const textOnly = channelPost(85_121_310, { blocks: [{ text: "пост", type: "paragraph" }] });

  it("treats a stored text-only post and its redelivery with the file as one update", () => {
    expect(sameTelegramIngressPayload(textOnly, withFile)).toBe(true);
  });

  // The grant was removed between the first delivery (stored with its file) and the redelivery,
  // which the ingress now stores without it: the same update, not AGENT_TELEGRAM_UPDATE_CONFLICT.
  it("treats a stored post with its file and a stripped redelivery as one update", () => {
    expect(sameTelegramIngressPayload(withFile, textOnly)).toBe(true);
  });

  it("still sees a conflict for other text, another kept file, or a non-rich difference", () => {
    const otherText = channelPost(85_121_310, { blocks: [{ text: "другой пост", type: "paragraph" }] });
    const otherFile = channelPost(85_121_310, { blocks: [{ photo: [{ file_id: "other" }], type: "photo" }, { text: "пост", type: "paragraph" }] });
    expect(sameTelegramIngressPayload(withFile, otherText)).toBe(false);
    expect(sameTelegramIngressPayload(withFile, otherFile)).toBe(false);
    expect(sameTelegramIngressPayload({ message: { text: "а" }, update_id: 1 }, { message: { text: "б" }, update_id: 1 })).toBe(false);
  });

  it("ignores key order the way jsonb does", () => {
    expect(sameTelegramIngressPayload({ message: { chat: { id: 1 }, text: "а" }, update_id: 1 }, { update_id: 1, message: { text: "а", chat: { id: 1 } } })).toBe(true);
  });
});
