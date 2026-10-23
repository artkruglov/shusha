/**
 * Persistent workspace filesystem boundary.
 *
 * Exports:
 * - `workspaceDirectory`: maps an opaque workspace ID to its physical directory.
 * - `getWorkspaceStoredFile`: reads trusted filesystem metadata for one confined path.
 * - `listWorkspaceStoredFiles`: recursively discovers regular files without an external index.
 * - `listWorkspaceStoredFilesUnder`: confines discovery to one verified relative directory.
 * - `readWorkspaceFile`, `writeWorkspaceFile`, `deleteWorkspaceFile`: confined file I/O.
 *
 * Key construct:
 * - The workspace is shared with the sandbox, which can swap any entry for a symlink at any
 *   moment. Checking a path and then using it raced: a swap between the two made the agent read
 *   a file outside the workspace (security review, 5 October 2026), and the agent's own
 *   `/proc/self/environ` holds its secrets. Every operation now walks the path one component at
 *   a time from the workspace directory, each component opened with O_NOFOLLOW relative to the
 *   descriptor of its parent (`/proc/self/fd/N/name` is Linux's openat for Node, which has no
 *   openat), and acts on the final descriptor. A swap after a component was opened changes
 *   nothing; a swap before it is refused as a symlink.
 */
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { WORKSPACE_MAX_FILE_BYTES } from "../../config.js";
import { AppError } from "../app-error.js";
import { validateWorkspacePath } from "./workspace-path.js";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// O_NONBLOCK keeps a FIFO planted under a file's name from blocking the open forever.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export function workspaceDirectory(root: string, workspaceId: string): string {
  if (!/^[0-9a-f-]{36}$/u.test(workspaceId)) {
    throw new AppError("AGENT_WORKSPACE_ID_INVALID", "Идентификатор workspace некорректен");
  }
  return join(root, workspaceId);
}

export interface WorkspaceStoredFile {
  byteSize: number;
  path: string;
  updatedAt: Date;
}

/** The path of `name` inside the directory a descriptor holds, resolved by the kernel from it. */
function at(directory: FileHandle, name: string): string {
  return `/proc/self/fd/${directory.fd}/${name}`;
}

/** Closes a handle whose own close failure must not hide the outcome being reported. */
async function closeQuietly(handle: FileHandle): Promise<void> {
  await handle.close().catch(() => undefined);
}

function notFound(): AppError {
  return new AppError("AGENT_WORKSPACE_FILE_NOT_FOUND", "Файл не найден в выбранном workspace");
}

function symlinkForbidden(): AppError {
  return new AppError("AGENT_WORKSPACE_SYMLINK_FORBIDDEN", "Символические ссылки запрещены в workspace");
}

/** Maps a refused open of `name` under `parent` to the workspace error it means. */
async function openError(error: unknown, parent: FileHandle, name: string, directoryExpected: boolean): Promise<Error> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return notFound();
  if (code === "ELOOP") return symlinkForbidden();
  if (code === "ENOTDIR") {
    // O_DIRECTORY with O_NOFOLLOW refuses a symlink as ENOTDIR as well: tell the two apart.
    const metadata = await lstat(at(parent, name)).catch(() => null);
    if (metadata?.isSymbolicLink()) return symlinkForbidden();
    return new AppError(
      "AGENT_WORKSPACE_PATH_INVALID",
      directoryExpected ? "Путь внутри workspace проходит через обычный файл" : "Путь должен указывать на обычный файл",
    );
  }
  return error as Error;
}

async function openWorkspaceRoot(root: string, workspaceId: string): Promise<FileHandle> {
  const directory = workspaceDirectory(root, workspaceId);
  try {
    return await open(directory, DIRECTORY_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw notFound();
    if (code === "ELOOP") throw symlinkForbidden();
    if (code === "ENOTDIR") {
      // O_NOFOLLOW with O_DIRECTORY refuses a symlinked root as ENOTDIR too: tell the two apart.
      const metadata = await lstat(directory).catch(() => null);
      if (metadata?.isSymbolicLink()) throw symlinkForbidden();
      throw new AppError("AGENT_WORKSPACE_PATH_INVALID", "Корень workspace должен быть каталогом");
    }
    throw error;
  }
}

/**
 * Opens the directory `segments` lead to inside the workspace, one component at a time; with
 * `create`, missing directories are made on the way. The caller closes the returned handle.
 */
async function openDirectory(
  root: string,
  workspaceId: string,
  segments: readonly string[],
  create: boolean,
): Promise<FileHandle> {
  // The workspace directory itself is the sandbox's mount point, not an entry it can replace;
  // a first write creates it as before.
  if (create) await mkdir(workspaceDirectory(root, workspaceId), { recursive: true });
  let current = await openWorkspaceRoot(root, workspaceId);
  try {
    for (const segment of segments) {
      if (create) {
        await mkdir(at(current, segment)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") return;
          // The directory held by `current` was removed meanwhile (by the sandbox).
          if (error.code === "ENOENT") throw new AppError("AGENT_WORKSPACE_FILE_NOT_FOUND", "Каталог файла удалён во время записи");
          throw error;
        });
      }
      let next: FileHandle;
      try {
        next = await open(at(current, segment), DIRECTORY_FLAGS);
      } catch (error) {
        throw await openError(error, current, segment, true);
      }
      // Ownership moves to the next handle before the previous one is closed, so a failing
      // close leaks neither (Codex review, 5 October 2026).
      const previous = current;
      current = next;
      await closeQuietly(previous);
    }
    return current;
  } catch (error) {
    await closeQuietly(current);
    throw error;
  }
}

function splitPath(path: string): { directory: string[]; name: string } {
  const segments = validateWorkspacePath(path).split("/");
  return { directory: segments.slice(0, -1), name: segments.at(-1)! };
}

/** Opens a regular file for reading and returns it with its metadata; the caller closes it. */
async function openRegularFile(
  root: string,
  workspaceId: string,
  path: string,
): Promise<{ file: FileHandle; metadata: Stats }> {
  const { directory, name } = splitPath(path);
  const parent = await openDirectory(root, workspaceId, directory, false);
  let file: FileHandle;
  try {
    file = await open(at(parent, name), READ_FLAGS);
  } catch (error) {
    throw await openError(error, parent, name, false);
  } finally {
    await closeQuietly(parent);
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      throw new AppError("AGENT_WORKSPACE_PATH_INVALID", "Путь должен указывать на обычный файл");
    }
    return { file, metadata };
  } catch (error) {
    await closeQuietly(file);
    throw error;
  }
}

/** Regular files below an open directory, without following any symlink; `prefix` is its path. */
async function scanDirectory(directory: FileHandle, prefix: string): Promise<WorkspaceStoredFile[]> {
  const entries = await readdir(`/proc/self/fd/${directory.fd}`, { withFileTypes: true });
  const files: WorkspaceStoredFile[] = [];
  for (const entry of entries) {
    if (entry.name.includes(".osinara-") && entry.name.endsWith(".tmp")) continue;
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const metadata = await lstat(at(directory, entry.name)).catch(() => null);
    if (!metadata) continue;
    if (metadata.isSymbolicLink()) throw symlinkForbidden();
    if (metadata.isDirectory()) {
      let child: FileHandle;
      try {
        child = await open(at(directory, entry.name), DIRECTORY_FLAGS);
      } catch (error) {
        // Swapped for a symlink after the lstat above; refused like any symlink.
        throw await openError(error, directory, entry.name, true);
      }
      try {
        files.push(...await scanDirectory(child, path));
      } finally {
        await closeQuietly(child);
      }
      continue;
    }
    if (!metadata.isFile()) continue;
    files.push({ byteSize: metadata.size, path, updatedAt: metadata.mtime });
  }
  return files;
}

export async function listWorkspaceStoredFiles(
  root: string,
  workspaceId: string,
): Promise<WorkspaceStoredFile[]> {
  let directory: FileHandle;
  try {
    directory = await openWorkspaceRoot(root, workspaceId);
  } catch (error) {
    if (error instanceof AppError && error.code === "AGENT_WORKSPACE_FILE_NOT_FOUND") return [];
    throw error;
  }
  try {
    const files = await scanDirectory(directory, "");
    return files.sort((left, right) => left.path.localeCompare(right.path));
  } finally {
    await closeQuietly(directory);
  }
}

export async function listWorkspaceStoredFilesUnder(
  root: string,
  workspaceId: string,
  path: string,
): Promise<WorkspaceStoredFile[]> {
  const safePath = validateWorkspacePath(path);
  let directory: FileHandle;
  try {
    directory = await openDirectory(root, workspaceId, safePath.split("/"), false);
  } catch (error) {
    if (error instanceof AppError && error.code === "AGENT_WORKSPACE_FILE_NOT_FOUND") {
      throw new AppError("AGENT_WORKSPACE_FILE_NOT_FOUND", "Каталог файла не найден в выбранном workspace");
    }
    if (error instanceof AppError && error.code === "AGENT_WORKSPACE_PATH_INVALID") {
      throw new AppError("AGENT_WORKSPACE_PATH_INVALID", "Путь workspace должен указывать на каталог");
    }
    throw error;
  }
  try {
    const files = await scanDirectory(directory, safePath);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  } finally {
    await closeQuietly(directory);
  }
}

export async function getWorkspaceStoredFile(
  root: string,
  workspaceId: string,
  path: string,
): Promise<WorkspaceStoredFile> {
  const safePath = validateWorkspacePath(path);
  const { file, metadata } = await openRegularFile(root, workspaceId, safePath);
  await closeQuietly(file);
  return { byteSize: metadata.size, path: safePath, updatedAt: metadata.mtime };
}

export async function readWorkspaceFile(
  root: string,
  workspaceId: string,
  path: string,
): Promise<Buffer> {
  const { file, metadata } = await openRegularFile(root, workspaceId, path);
  try {
    if (metadata.size > WORKSPACE_MAX_FILE_BYTES) {
      throw new AppError("AGENT_WORKSPACE_FILE_TOO_LARGE", "Файл превышает допустимый размер 50 МБ");
    }
    const content = await file.readFile();
    if (content.byteLength > WORKSPACE_MAX_FILE_BYTES) {
      throw new AppError("AGENT_WORKSPACE_FILE_TOO_LARGE", "Файл превышает допустимый размер 50 МБ");
    }
    return content;
  } finally {
    await closeQuietly(file);
  }
}

export async function writeWorkspaceFile(
  root: string,
  workspaceId: string,
  path: string,
  content: Uint8Array,
): Promise<void> {
  if (content.byteLength > WORKSPACE_MAX_FILE_BYTES) {
    throw new AppError("AGENT_WORKSPACE_FILE_TOO_LARGE", "Файл превышает допустимый размер 50 МБ");
  }
  const { directory, name } = splitPath(path);
  const parent = await openDirectory(root, workspaceId, directory, true);
  // Rename makes readers observe either the old complete file or the new complete file; both
  // names resolve through the parent's descriptor, so neither can land outside the workspace.
  // The temporary file is removed whatever fails after it exists: the write (ENOSPC), the close
  // or the rename.
  const temporary = `${name}.osinara-${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(at(parent, temporary), CREATE_FLAGS, 0o644).catch((error: NodeJS.ErrnoException) => {
      // The directory held by its descriptor was removed meanwhile (by the sandbox).
      if (error.code === "ENOENT") throw new AppError("AGENT_WORKSPACE_FILE_NOT_FOUND", "Каталог файла удалён во время записи");
      throw error;
    });
    try {
      await file.writeFile(content);
    } finally {
      await file.close();
    }
    await rename(at(parent, temporary), at(parent, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EISDIR" || error.code === "ENOTDIR") {
        throw new AppError("AGENT_WORKSPACE_PATH_INVALID", "Путь должен указывать на обычный файл");
      }
      if (error.code === "ENOENT") throw new AppError("AGENT_WORKSPACE_FILE_NOT_FOUND", "Каталог файла удалён во время записи");
      throw error;
    });
  } finally {
    await rm(at(parent, temporary), { force: true }).catch(() => undefined);
    await closeQuietly(parent);
  }
}

export async function deleteWorkspaceFile(
  root: string,
  workspaceId: string,
  path: string,
): Promise<boolean> {
  const { directory, name } = splitPath(path);
  let parent: FileHandle;
  try {
    parent = await openDirectory(root, workspaceId, directory, false);
  } catch (error) {
    if (error instanceof AppError && error.code === "AGENT_WORKSPACE_FILE_NOT_FOUND") return false;
    throw error;
  }
  try {
    const metadata = await lstat(at(parent, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return false;
    if (metadata.isSymbolicLink()) throw symlinkForbidden();
    if (metadata.isDirectory()) {
      throw new AppError("AGENT_WORKSPACE_PATH_INVALID", "Путь должен указывать на обычный файл");
    }
    // unlink removes the entry itself, never what a symlink swapped in since would point to; a
    // directory swapped in since the check is refused with the same code as one found by it.
    await unlink(at(parent, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return;
      if (error.code === "EISDIR" || error.code === "EPERM") {
        throw new AppError("AGENT_WORKSPACE_PATH_INVALID", "Путь должен указывать на обычный файл");
      }
      throw error;
    });
    return true;
  } finally {
    await closeQuietly(parent);
  }
}

export async function clearWorkspaceDirectory(root: string, workspaceId: string): Promise<void> {
  const directory = workspaceDirectory(root, workspaceId);
  await rm(directory, { force: true, recursive: true });
  await rm(join(root, ".derived", workspaceId), { force: true, recursive: true });
  await mkdir(directory, { recursive: true });
}

export async function deleteWorkspaceDirectory(root: string, workspaceId: string): Promise<void> {
  await rm(workspaceDirectory(root, workspaceId), { force: true, recursive: true });
  await rm(join(root, ".derived", workspaceId), { force: true, recursive: true });
}
