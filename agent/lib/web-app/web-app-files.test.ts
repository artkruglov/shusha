/**
 * «Мои картинки и файлы»: what of a folder reaches the gallery, and the preview and send routes with fake storage.
 */
import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("../database-context.js", () => ({ withFamilyDatabaseContext: (_: string, work: () => unknown) => work() }));

import { galleryItems } from "./web-app-files.js";
import { createWebAppMoreApi, webAppMoreDependencies } from "./web-app-more-api.js";

const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, "0")}T10:00:00Z`);
const TOKEN = "123456:files-test";

function initData(id: string): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ first_name: "Т", id: Number(id) }) };
  const check = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}

describe("Mini App gallery", () => {
  it("keeps the bot's pictures, videos and documents, newest first, and nothing else", () => {
    const items = galleryItems([
      { byteSize: 10, path: "generated-images/image-a.png", updatedAt: at(14) },
      { byteSize: 20, path: "generated-images/image-b.webp", updatedAt: at(16) },
      { byteSize: 30, path: "generated-videos/video-c.mp4", updatedAt: at(15) },
      { byteSize: 40, path: "reports/plan.docx", updatedAt: at(13) },
      { byteSize: 50, path: "lists/qa.md", updatedAt: at(17) },
      { byteSize: 60, path: "notes.txt", updatedAt: at(18) },
      { byteSize: 70, path: "generated-images/readme.txt", updatedAt: at(18) },
    ], "personal");
    expect(items.map((item) => [item.kind, item.path])).toEqual([
      ["image", "generated-images/image-b.webp"], ["video", "generated-videos/video-c.mp4"],
      ["image", "generated-images/image-a.png"], ["document", "reports/plan.docx"],
    ]);
    expect(items[0]).toMatchObject({ name: "image-b.webp", scope: "personal", size: 20 });
  });

  it("serves a preview as bytes with its type, and sends a file to the person's own chat once per key", async () => {
    const sendFile = vi.fn(async () => undefined);
    const api = createWebAppMoreApi({
      ...webAppMoreDependencies,
      botToken: () => TOKEN,
      filePreview: async () => ({ bytes: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" }),
      findIdentity: async () => ({ familyId: "f", role: "member", userId: "u" } as never),
      sendFile,
      turnSpace: async () => null,
    });
    const headers = { authorization: `tma ${initData("700101")}` };
    const preview = await api.filePreview(new Request("https://x/app-api/files/preview?scope=personal&path=generated-images/image-a.png", { headers }));
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));

    const sent = await api.sendFile(new Request("https://x/app-api/files/send", {
      body: JSON.stringify({ nonce: "nonce-123456", path: "generated-images/image-a.png", purpose: "variant", scope: "personal" }), headers, method: "POST",
    }));
    expect(sent.status).toBe(200);
    expect(sendFile).toHaveBeenCalledWith(expect.objectContaining({ userId: "u" }),
      { path: "generated-images/image-a.png", purpose: "variant", scope: "personal" }, "webapp:u:nonce-123456");
    const bad = await api.sendFile(new Request("https://x/app-api/files/send", {
      body: JSON.stringify({ nonce: "nonce-654321", path: "x.png", purpose: "print", scope: "personal" }), headers, method: "POST",
    }));
    expect(bad.status).toBe(400);
  });
});
