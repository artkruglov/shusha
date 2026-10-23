/**
 * «Надиктовать»: запись принимается только своим контейнером и только от подписанного человека, текст отдаётся как есть.
 */
import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createVoiceThrottle, createWebAppVoiceApi, voiceMediaType } from "./web-app-voice.js";

const TOKEN = "123456:voice-test";
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);

function initData(id: number): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id }) };
  const check = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}

describe("Mini App voice", () => {
  it("names the container by the header and the bytes together", () => {
    expect(voiceMediaType("audio/webm;codecs=opus", WEBM)).toBe("audio/webm");
    expect(voiceMediaType("audio/mp4", new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x4d]))).toBe("audio/mp4");
    expect(() => voiceMediaType("audio/mp4", WEBM)).toThrow(/не получилось прочитать/u);
    expect(() => voiceMediaType("audio/wav", WEBM)).toThrow();
  });

  it("transcribes a signed person's recording and refuses an unsigned one before any work", async () => {
    const transcribe = vi.fn(async () => "молоко\nхлеб");
    const api = createWebAppVoiceApi({
      botToken: () => TOKEN, findIdentity: async () => ({ familyId: "f", role: "owner", userId: "u" }) as never,
      now: () => new Date(), throttle: createVoiceThrottle(), transcribe, turnSpace: async () => null,
    });
    const post = (headers: Record<string, string>) =>
      api.transcribe(new Request("https://x/app-api/voice", { body: WEBM, headers: { "content-type": "audio/webm", ...headers }, method: "POST" }));
    expect((await post({})).status).toBe(401);
    expect(transcribe).not.toHaveBeenCalled();
    const ok = await post({ authorization: `tma ${initData(42)}` });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ text: "молоко\nхлеб" });
    expect(transcribe).toHaveBeenCalledWith(WEBM, "audio/webm");
    // A second recording right away waits: the host has one recognizer for the chat and the app.
    expect((await post({ authorization: `tma ${initData(42)}` })).status).toBe(429);
  });

  it("counts a person's recordings per day with a pause between them", () => {
    const throttle = createVoiceThrottle();
    const at = (seconds: number) => new Date(Date.UTC(2026, 9, 21, 10, 0, seconds));
    expect(throttle.take("u", at(0))).toBe(true);
    expect(throttle.take("u", at(2))).toBe(false);
    expect(throttle.take("u", at(6))).toBe(true);
    expect(throttle.take("v", at(6))).toBe(true);
  });
});
