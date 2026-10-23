/**
 * Telegram attachment download tests.
 *
 * Constructs covered:
 * - `createTelegramAttachmentDownloader`: declared and actual 20 MB download limits.
 * - Telegram getFile/download response validation.
 * - Transport and response-body failures return a bounded correction contract.
 */
import type { TelegramAttachment } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { createTelegramAttachmentDownloader } from "./telegram-attachment-download.js";

const attachment = (size: number): TelegramAttachment => ({
  fileId: "file-id",
  fileName: "notes.txt",
  kind: "document",
  mediaType: "text/plain",
  size,
});

describe("createTelegramAttachmentDownloader", () => {
  it("downloads an accepted file through Eve's public Telegram API", async () => {
    const getFile = vi.fn().mockResolvedValue({ filePath: "documents/file.txt" });
    const downloadFile = vi.fn().mockResolvedValue(new Response("content", { status: 200 }));
    const download = createTelegramAttachmentDownloader({ downloadFile, getFile });

    await expect(download(attachment(7))).resolves.toEqual(Buffer.from("content"));
    expect(getFile).toHaveBeenCalledWith("file-id");
    expect(downloadFile).toHaveBeenCalledWith("documents/file.txt");
  });

  it("rejects declared oversized input before any provider call", async () => {
    const getFile = vi.fn();
    const download = createTelegramAttachmentDownloader({
      downloadFile: vi.fn(),
      getFile,
    });

    await expect(download(attachment(20 * 1024 * 1024 + 1)))
      .rejects.toThrowError(/AGENT_ATTACHMENT_DOWNLOAD_TOO_LARGE/);
    expect(getFile).not.toHaveBeenCalled();
  });

  it("normalizes Telegram transport failures and asks for a fresh attachment", async () => {
    const download = createTelegramAttachmentDownloader({
      downloadFile: vi.fn(),
      getFile: vi.fn().mockRejectedValue(new Error("socket 10.0.0.7 closed")),
    });

    await expect(download(attachment(7))).rejects.toMatchObject({
      contract: {
        code: "AGENT_ATTACHMENT_DOWNLOAD_FAILED",
        retryable: false,
        sideEffectStatus: "not_started",
      },
    });
    await expect(download(attachment(7))).rejects.not.toThrow(/10\.0\.0\.7/u);
  });

  it("stops reading a body without Content-Length once it passes the limit", async () => {
    // Security review, 5 October 2026: the whole body was buffered (24 MB here) before its size
    // was compared with the 20 MB limit.
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 24) controller.close();
        else controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const download = createTelegramAttachmentDownloader({
      downloadFile: vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
      getFile: vi.fn().mockResolvedValue({ filePath: "documents/file.bin" }),
    });

    await expect(download(attachment(7))).rejects.toThrowError(/AGENT_ATTACHMENT_DOWNLOAD_TOO_LARGE/);
    expect(pulled).toBeLessThanOrEqual(22);
  });

  it("normalizes a response-body stream failure", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket 10.0.0.8 closed"));
      },
    }), { status: 200 });
    const download = createTelegramAttachmentDownloader({
      downloadFile: vi.fn().mockResolvedValue(response),
      getFile: vi.fn().mockResolvedValue({ filePath: "documents/file.txt" }),
    });

    await expect(download(attachment(7))).rejects.toMatchObject({
      contract: {
        code: "AGENT_ATTACHMENT_DOWNLOAD_FAILED",
        retryable: false,
        sideEffectStatus: "not_started",
      },
    });
  });
});
