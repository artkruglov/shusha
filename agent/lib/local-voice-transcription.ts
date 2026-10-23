/** Local GigaAM route within the existing authorized durable voice pipeline. */
import { AppError } from './app-error.js';

/** The containers the GigaAM service takes, each checked by its own signature there (`infra/gigaam/server.py`). */
export type VoiceMediaType = 'audio/ogg' | 'audio/webm' | 'audio/mp4';

/** A busy answer is retried this many times this far apart: the service had not started on the recording. */
const BUSY_RETRIES = 6;
const BUSY_WAIT_MS = 5_000;

export async function transcribeLocalVoice(
  audio: Uint8Array,
  apiKey: string | undefined,
  request: typeof fetch = fetch,
  mediaType: VoiceMediaType = 'audio/ogg',
  busyWaitMs = BUSY_WAIT_MS,
): Promise<string> {
  if (!apiKey?.trim()) throw new AppError('AGENT_VOICE_NOT_CONFIGURED', 'Локальное распознавание голосовых не настроено');
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await request('http://gigaam:8000/transcribe', {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': mediaType },
        body: Buffer.from(audio), signal: AbortSignal.timeout(180_000),
      });
    } catch {
      throw new AppError('AGENT_VOICE_SERVICE_UNAVAILABLE', 'Сервис распознавания не ответил. Автоматический повтор не выполнялся; попробуйте позже');
    }
    // One recording at a time there: a voice note in the chat waits out a dictation in the app instead of failing.
    // Only «busy» is retried; it is answered before the service reads the audio, so nothing runs twice.
    if (response.status !== 503 || attempt >= BUSY_RETRIES) break;
    const answer: unknown = await response.clone().json().catch(() => null);
    if (!(answer && typeof answer === 'object' && 'error' in answer && answer.error === 'busy')) break;
    await new Promise((resolve) => setTimeout(resolve, busyWaitMs));
  }
  if (response.status === 413) throw new AppError('AGENT_VOICE_FILE_TOO_LARGE', 'Голосовое слишком длинное. Отправьте запись не длиннее трёх минут');
  // Still busy after the waits: not a broken recording, so it is said so.
  if (response.status === 503 && (await response.clone().json().catch(() => null) as { error?: unknown } | null)?.error === 'busy') {
    throw new AppError('AGENT_VOICE_BUSY', 'Распознавание сейчас занято другой записью. Попробуйте через минуту');
  }
  if (!response.ok) throw new AppError('AGENT_VOICE_TRANSCRIPTION_FAILED', 'Не удалось распознать голосовое сообщение. Попробуйте позже или напишите текстом');
  const value: unknown = await response.json();
  const text = value && typeof value === 'object' && 'text' in value ? value.text : null;
  if (typeof text !== 'string' || !text.trim() || text.length > 40_000) {
    throw new AppError('AGENT_VOICE_TRANSCRIPT_EMPTY', 'Не удалось разобрать речь. Попробуйте записать сообщение ещё раз');
  }
  return text.trim();
}
