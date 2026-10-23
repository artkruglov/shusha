/**
 * «Надиктовать» в Mini App: `POST /app-api/voice` с записью из браузера, ответ это текст. Модели нет: человек сам
 * правит строки и записывает их делами или покупками обычными маршрутами.
 *
 * Exports:
 * - `VOICE_UPLOAD_MAX_BYTES`: предел записи (три минуты речи с запасом).
 * - `voiceMediaType`: контейнер записи по заголовку и сигнатуре байтов, иначе отказ.
 * - `WebAppVoiceDependencies`, `createWebAppVoiceApi`, `webAppVoiceApi`: обработчик и его производственная сборка.
 *
 * Запись идёт тем же распознаванием, что голосовое из чата (`transcribeVoiceAudio`: GigaAM на хосте или Groq), и
 * нигде не сохраняется. Человек только из подписи `initData`; частоту ограничивает nginx (зона загрузок), а число
 * записей за день и паузу между ними на человека `VoiceThrottle`: распознавание одно на хост, и голосовые из чата
 * ждут, пока оно занято.
 */
import { AppError } from "../app-error.js";
import { transcribeVoiceAudio } from "../groq-voice-transcription.js";
import type { VoiceMediaType } from "../local-voice-transcription.js";
import { authorizeWebApp, webAppApiDependencies, webAppBadRequest, webAppFailure, webAppJson, type WebAppApiDependencies } from "./web-app-api.js";
import { readLimitedBody } from "./web-app-photo-upload.js";

/** Opus at Telegram's voice bitrate runs well under 1 MB a minute; AAC from an iPhone is larger. */
export const VOICE_UPLOAD_MAX_BYTES = 6 * 1024 * 1024;

const SIGNATURES: Record<VoiceMediaType, (bytes: Uint8Array) => boolean> = {
  "audio/mp4": (bytes) => bytes.length > 8 && String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp",
  "audio/ogg": (bytes) => bytes.length > 4 && String.fromCharCode(...bytes.subarray(0, 4)) === "OggS",
  "audio/webm": (bytes) => bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3,
};

/** «audio/webm;codecs=opus» → «audio/webm», only when the bytes are that container. */
export function voiceMediaType(header: string | null, bytes: Uint8Array): VoiceMediaType {
  const type = (header ?? "").split(";")[0]!.trim().toLowerCase();
  const known = type in SIGNATURES ? (type as VoiceMediaType) : null;
  if (known === null || !SIGNATURES[known](bytes)) {
    throw new AppError("AGENT_WEB_APP_VOICE_FORMAT", "Эту запись не получилось прочитать. Попробуйте ещё раз или наберите текстом");
  }
  return known;
}

/** Recordings a person may send in a day, and the least pause between two. */
const VOICE_PER_DAY = 40;
const VOICE_GAP_MS = 5_000;

export interface VoiceThrottle {
  /** True when this person may send one more recording now; counts it. */
  take(userId: string, now: Date): boolean;
}

/** In process memory, as the hint limit: one agent process serves the Mini App, a restart forgets nothing costly. */
export function createVoiceThrottle(): VoiceThrottle {
  const seen = new Map<string, { count: number; day: string; last: number }>();
  return {
    take(userId, now) {
      const day = now.toISOString().slice(0, 10);
      const entry = seen.get(userId);
      const current = entry && entry.day === day ? entry : { count: 0, day, last: 0 };
      if (current.count >= VOICE_PER_DAY || now.getTime() - current.last < VOICE_GAP_MS) return false;
      seen.set(userId, { count: current.count + 1, day, last: now.getTime() });
      return true;
    },
  };
}

export interface WebAppVoiceDependencies extends Pick<WebAppApiDependencies, "botToken" | "findIdentity" | "now" | "turnSpace"> {
  throttle: VoiceThrottle;
  transcribe(audio: Uint8Array, mediaType: VoiceMediaType): Promise<string>;
}

export function createWebAppVoiceApi(dependencies: WebAppVoiceDependencies) {
  return {
    async transcribe(request: Request): Promise<Response> {
      try {
        const auth = await authorizeWebApp(request, dependencies);
        if (!dependencies.throttle.take(auth.userId ?? "", dependencies.now())) {
          throw new AppError("AGENT_WEB_APP_VOICE_LIMITED", "Записей на сегодня уже много. Наберите текстом или попробуйте завтра");
        }
        if (Number(request.headers.get("content-length") ?? "0") > VOICE_UPLOAD_MAX_BYTES) webAppBadRequest();
        const bytes = await readLimitedBody(request, VOICE_UPLOAD_MAX_BYTES).catch(() => {
          throw new AppError("AGENT_VOICE_FILE_TOO_LARGE", "Запись слишком длинная. Надиктуйте покороче, до трёх минут");
        });
        const mediaType = voiceMediaType(request.headers.get("content-type"), bytes);
        const text = await dependencies.transcribe(bytes, mediaType);
        console.info(JSON.stringify({ bytes: bytes.length, code: "AGENT_WEB_APP_VOICE_TRANSCRIBED", mediaType }));
        return webAppJson(200, { text });
      } catch (error) {
        return webAppFailure(error);
      }
    },
  };
}

export const webAppVoiceApi = createWebAppVoiceApi({ ...webAppApiDependencies, throttle: createVoiceThrottle(), transcribe: transcribeVoiceAudio });
