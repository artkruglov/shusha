/** A Studio photo's type comes from its bytes, and its path from their digest. */
import { describe, expect, it } from "vitest";

import { photoUploadPath, readLimitedBody } from "./web-app-photo-upload.js";

const NOW = new Date("2026-10-19T12:00:00Z");

describe("Studio photo upload path", () => {
  it("names the file by its signature, not by what the page claims", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect(photoUploadPath(jpeg, NOW)).toMatchObject({ mediaType: "image/jpeg" });
    expect(photoUploadPath(jpeg, NOW).path).toMatch(/^photos\/photo-2026-10-19-[0-9a-f]{12}\.jpg$/u);
  });

  it("refuses bytes that are not a picture", () => {
    expect(() => photoUploadPath(new TextEncoder().encode("<svg onload=alert(1)>"), NOW))
      .toThrow(expect.objectContaining({ code: "AGENT_WEB_APP_BAD_REQUEST" }));
  });
});

describe("Studio photo body", () => {
  it("stops reading right past the limit, even without a length", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
        if (pulled > 100) controller.close();
      },
    });
    const request = new Request("http://local/upload", { body, duplex: "half", method: "POST" } as RequestInit);
    await expect(readLimitedBody(request, 4096)).rejects.toMatchObject({ code: "AGENT_WEB_APP_BAD_REQUEST" });
    expect(pulled).toBeLessThan(10);
  });

  it("returns the whole body under the limit", async () => {
    const request = new Request("http://local/upload", { body: new Uint8Array([1, 2, 3]), method: "POST" });
    expect(Array.from(await readLimitedBody(request, 4096))).toEqual([1, 2, 3]);
  });
});
