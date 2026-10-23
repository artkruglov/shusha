/**
 * «Мои картинки и файлы» в Mini App: что бот нарисовал, снял и собрал, превью картинок и отправка файла в личку.
 *
 * Exports:
 * - `WebAppFileKind`, `WebAppFile`, `WebAppFileSend`: то, что получает и присылает страница.
 * - `galleryItems`: какие файлы рабочей папки попадают в галерею и как называются.
 * - `privateWorkspaceAuthorization`: права лички для рабочих папок.
 * - `webAppFiles`: список, байты превью и отправка.
 *
 * Папки те же, что видит личка в чате (`workspaceRepository.mounts`): личная и, у семьи без пространств, семейная.
 * Путь из запроса проходит `validateWorkspacePath` и читается тем же безопасным хранилищем, что инструменты; превью
 * отдаётся только картинкам. Отправка идёт тем же путём, что доставка готового видео (`sendAuthorizedWorkspaceFile`):
 * получатель только сам человек, повтор по ключу операции не шлёт файл второй раз. «Сделать вариант» и «Оживить»
 * присылают картинку с подписью «ответьте на это сообщение»: правку делает ход модели в чате, где оплата и проверки.
 */
import { resolve } from "node:path";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import { sendAuthorizedWorkspaceFile } from "../workspaces/workspace-file-sender.js";
import { validateWorkspacePath } from "../workspaces/workspace-path.js";
import { workspaceRepository, type WorkspaceAuthorization, type WorkspaceScope } from "../workspaces/workspace-repository.js";
import { listWorkspaceStoredFiles, type WorkspaceStoredFile } from "../workspaces/workspace-storage.js";

const WORKSPACE_ROOT = resolve("workspaces");
const PER_KIND = 60;
/** Telegram shows a photo up to 10 MB; a larger preview would only slow the page. */
const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE = /\.(png|jpe?g|webp)$/iu;
const DOCUMENT = /\.(docx|pdf|xlsx|pptx|csv|md)$/iu;

export type WebAppFileKind = "document" | "image" | "video";

export interface WebAppFile {
  readonly kind: WebAppFileKind;
  readonly scope: "family" | "personal";
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly at: string;
  /** What was asked for a picture, when the bot kept it (pictures made from 19 October 2026). */
  readonly caption?: string;
}

export type WebAppFileSend = "animate" | "send" | "variant";

const CAPTIONS: Readonly<Record<WebAppFileSend, string | undefined>> = {
  animate: "Ответьте на это сообщение, как оживить: что должно двигаться и как долго.",
  send: undefined,
  variant: "Ответьте на это сообщение, что изменить в картинке.",
};

function kindOf(path: string): WebAppFileKind | null {
  // Pictures Шуша drew and photos the person sent from the Studio (`web-app-photo-upload.ts`).
  if ((path.startsWith("generated-images/") || path.startsWith("photos/")) && IMAGE.test(path)) return "image";
  if (path.startsWith("generated-videos/") && path.toLowerCase().endsWith(".mp4")) return "video";
  // Documents the bot made live anywhere in the folder; the bot's own notes (memory export, lists) are not here.
  if (DOCUMENT.test(path) && !path.startsWith("lists/") && !path.startsWith(".")) return "document";
  return null;
}

/** The gallery's files of one folder, newest first, a limited number of each kind. */
export function galleryItems(files: readonly WorkspaceStoredFile[], scope: "family" | "personal"): WebAppFile[] {
  const counted = new Map<WebAppFileKind, number>();
  return [...files].sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()).flatMap((file) => {
    const kind = kindOf(file.path);
    if (kind === null) return [];
    const count = counted.get(kind) ?? 0;
    if (count >= PER_KIND) return [];
    counted.set(kind, count + 1);
    return [{ at: file.updatedAt.toISOString(), kind, name: file.path.split("/").at(-1)!, path: file.path, scope, size: file.byteSize }];
  });
}

export function privateWorkspaceAuthorization(auth: MemoryAuthorization): WorkspaceAuthorization {
  if (auth.userId === null || auth.telegramUserId === null) throw new AppError("AGENT_ACCESS_DENIED", "Нет доступа");
  return {
    ...(auth.space ? { space: auth.space } : {}),
    familyId: auth.familyId, groupId: null, groupType: null, role: auth.role as WorkspaceAuthorization["role"],
    telegramChatType: "private", userId: auth.userId,
  };
}

function requireListed(scope: string, path: string): { kind: WebAppFileKind; path: string; scope: "family" | "personal" } {
  if (scope !== "personal" && scope !== "family") throw new AppError("AGENT_WEB_APP_BAD_REQUEST", "Неверный запрос");
  const safe = validateWorkspacePath(path);
  const kind = kindOf(safe);
  if (kind === null) throw new AppError("AGENT_WEB_APP_NOT_FOUND", "Такого файла нет в галерее");
  return { kind, path: safe, scope };
}

/** The request words of the folder's generated pictures, by file path (the ledger keeps the stem without extension). */
async function captionsOf(workspaceId: string, paths: readonly string[]): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const stems = new Map(paths.map((path) => [path.replace(/\.[a-z0-9]+$/iu, ""), path]));
  const { rows } = await database().query<{ description: string; output_path: string }>(
    `SELECT output_path, description FROM image_generation_operations
      WHERE workspace_id = $1 AND output_path = ANY($2::text[]) AND description IS NOT NULL`,
    [workspaceId, [...stems.keys()]]);
  return new Map(rows.flatMap((row) => stems.has(row.output_path) ? [[stems.get(row.output_path)!, row.description] as const] : []));
}

export const webAppFiles = {
  async list(auth: MemoryAuthorization): Promise<WebAppFile[]> {
    const mounts = await workspaceRepository.mounts(privateWorkspaceAuthorization(auth));
    const files: WebAppFile[] = [];
    for (const mount of mounts) {
      if (mount.mountPoint !== "personal" && mount.mountPoint !== "family") continue;
      const items = galleryItems(await listWorkspaceStoredFiles(WORKSPACE_ROOT, mount.workspaceId), mount.mountPoint);
      const captions = await captionsOf(mount.workspaceId, items.filter((item) => item.kind === "image").map((item) => item.path));
      files.push(...items.map((item) => captions.has(item.path) ? { ...item, caption: captions.get(item.path)! } : item));
    }
    return files.sort((left, right) => right.at.localeCompare(left.at));
  },

  /** Bytes of one gallery picture for its preview; anything else is refused. */
  async preview(auth: MemoryAuthorization, scope: string, path: string): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const file = requireListed(scope, path);
    if (file.kind !== "image") throw new AppError("AGENT_WEB_APP_NOT_FOUND", "Превью есть только у картинок");
    const read = await workspaceBinaryRepository.readBinary(privateWorkspaceAuthorization(auth), file.scope as WorkspaceScope, file.path);
    if (!read.file.mediaType.startsWith("image/") || read.bytes.byteLength > PREVIEW_MAX_BYTES) {
      throw new AppError("AGENT_WEB_APP_NOT_FOUND", "Превью этой картинки нет");
    }
    return { bytes: read.bytes, mediaType: read.file.mediaType };
  },

  /** The file into the person's own private chat, without the model; a repeated tap with the same key sends nothing. */
  async send(auth: MemoryAuthorization, input: { path: string; purpose: WebAppFileSend; scope: string }, operationKey: string): Promise<void> {
    const file = requireListed(input.scope, input.path);
    if (input.purpose !== "send" && file.kind !== "image") throw new AppError("AGENT_WEB_APP_BAD_REQUEST", "Это действие только для картинок");
    const caption = CAPTIONS[input.purpose];
    await sendAuthorizedWorkspaceFile(
      { path: file.path, presentation: file.kind === "image" ? "photo" : "document", scope: file.scope as WorkspaceScope, ...(caption ? { caption } : {}) },
      {
        auth: privateWorkspaceAuthorization(auth), operationKey,
        projection: { applicationSessionId: null, forumTopicId: null, replyToEntryId: null },
        target: { chatId: auth.telegramUserId! },
      },
    );
  },
};
