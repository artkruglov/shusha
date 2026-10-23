/**
 * Фото с телефона для Студии: страница присылает сами байты картинки, сервер кладёт их в личную папку человека.
 *
 * Exports:
 * - `PHOTO_UPLOAD_MAX_BYTES`, `photoUploadPath`: предел размера и путь в папке, выведенный из байтов.
 * - `reservePhotoUpload`: предел и резерв nonce под блокировкой (для тестов и `save`).
 * - `readLimitedBody`: тело запроса с остановкой сразу за пределом, без чтения целиком.
 * - `webAppPhotoUpload`: сохранение фото по ключу `webapp-upload:<user>:<nonce>`.
 *
 * Key constructs:
 * - Тип файла определяется по сигнатуре (PNG, JPEG, WebP), заголовок `Content-Type` не доверяется.
 * - Сначала под транзакционной блокировкой папки (одно соединение) считается предел и резервируется nonce вместе с
 *   хэшем байтов (`webapp_upload_quota` в `workspace_operations`); только потом файл пишется. Повтор с тем же nonce и
 *   теми же байтами возвращает сохранённое фото, с другими байтами отклоняется.
 * - Фото лежит в `photos/` личной папки; галерея показывает его рядом с картинками Шуши, и его можно выбрать исходником.
 * - Предел — 30 фото в сутки: загрузка бесплатна, но место в папке нет.
 */
import { createHash } from "node:crypto";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { detectImageMediaType } from "../image-generation/flux-image-clients.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import { privateWorkspaceAuthorization } from "./web-app-files.js";

export const PHOTO_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const DAILY_LIMIT = 30;
const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;

export function photoUploadPath(bytes: Uint8Array, now: Date): { mediaType: keyof typeof EXTENSIONS; path: string } {
  const mediaType = detectImageMediaType(bytes);
  if (mediaType === null) throw new AppError("AGENT_WEB_APP_BAD_REQUEST", "Нужна фотография PNG, JPEG или WebP");
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  return { mediaType, path: `photos/photo-${now.toISOString().slice(0, 10)}-${digest}.${EXTENSIONS[mediaType]}` };
}

export async function readLimitedBody(request: Request, limit: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new AppError("AGENT_WEB_APP_BAD_REQUEST", "Фото должно быть не больше 10 МБ");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Counts today's uploads and reserves this nonce for these bytes under one per-workspace lock and connection. */
export async function reservePhotoUpload(workspaceId: string, operationKey: string, digest: string): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('webapp-upload:' || $1, 0))", [workspaceId]);
    const known = await client.query<{ digest: string }>(
      `SELECT result->>'digest' AS digest FROM workspace_operations
        WHERE operation_key = $1 AND workspace_id = $2 AND operation_type = 'webapp_upload_quota'`,
      [`${operationKey}:quota`, workspaceId]);
    if (known.rows[0]) {
      if (known.rows[0].digest !== digest) throw new AppError("AGENT_WEB_APP_BAD_REQUEST", "Этот запрос уже отправил другое фото");
    } else {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM workspace_operations
          WHERE workspace_id = $1 AND operation_type = 'webapp_upload_quota' AND created_at > now() - interval '1 day'`,
        [workspaceId]);
      if (Number(rows[0]?.count ?? 0) >= DAILY_LIMIT) {
        throw new AppError("AGENT_WEB_APP_STUDIO_LIMITED", "На сегодня фото уже много. Продолжим завтра");
      }
      await client.query(
        `INSERT INTO workspace_operations (operation_key, workspace_id, operation_type, result)
         VALUES ($1, $2, 'webapp_upload_quota', $3)`,
        [`${operationKey}:quota`, workspaceId, JSON.stringify({ digest })]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const webAppPhotoUpload = {
  async save(auth: MemoryAuthorization, bytes: Uint8Array, nonce: string, now: Date): Promise<{ path: string; scope: "personal" }> {
    if (bytes.byteLength === 0 || bytes.byteLength > PHOTO_UPLOAD_MAX_BYTES) {
      throw new AppError("AGENT_WEB_APP_BAD_REQUEST", "Фото должно быть не больше 10 МБ");
    }
    const { mediaType, path } = photoUploadPath(bytes, now);
    const workspaceAuth = privateWorkspaceAuthorization(auth);
    const operationKey = `webapp-upload:${auth.userId}:${nonce}`;
    const workspaceId = await workspaceBinaryRepository.workspaceId(workspaceAuth, "personal");
    await reservePhotoUpload(workspaceId, operationKey, createHash("sha256").update(bytes).digest("hex"));
    // The date in the path may differ on a replay after midnight; the write ledger then returns the first file.
    const file = await workspaceBinaryRepository.writeBinary(workspaceAuth, { bytes, mediaType, operationKey, path, scope: "personal" });
    return { path: file.path, scope: "personal" };
  },
};
