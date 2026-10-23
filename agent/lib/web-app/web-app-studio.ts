/**
 * Студия Шуши в Mini App: рецепт картинки запускается из приложения без разговора с моделью.
 *
 * Exports:
 * - `STUDIO_RECIPES`, `StudioRecipe`: рецепты и шаблоны запроса к модели картинок, собранные кодом.
 * - `studioPrompt`, `studioDescription`: запрос по рецепту и строке уточнения человека и подпись для галереи.
 * - `StudioState`: что страница видит о запуске.
 * - `studioReservations`: журнал операций картинок, где резервирование Студии проходит дневной предел под блокировкой.
 * - `webAppStudio`: запуск и состояние.
 *
 * Key constructs:
 * - Страница присылает id рецепта, путь исходника из своей галереи и строку уточнения; текст запроса собирает сервер.
 * - Картинку делает тот же путь, что инструмент чата (`image-generation-run.ts`): одна оплачиваемая генерация на ключ
 *   `webapp-studio:<user>:<nonce>`, повтор нажатия ничего не рисует второй раз.
 * - Генерация идёт в фоне (до минуты), ответ запроса сразу: страница спрашивает состояние по тому же nonce, а готовая
 *   картинка приходит в личку человека тем же отправителем файлов, что готовое видео.
 * - Предел — 20 картинок Студии в сутки на человека: Студия не должна стать бесконечной кнопкой оплаты. Подсчёт и
 *   резервирование идут под транзакционной advisory-блокировкой папки, так что параллельные нажатия его не обходят.
 * - Повтор того же nonce доводит застрявшее: готовую, но не отправленную картинку отправляет (ключ доставки тот же,
 *   второй раз не уйдёт), а давно начатую восстанавливает из записи в папку, не рисуя заново.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";
import { imageGenerationClient, type ImageMediaType } from "../image-generation/image-generation-client.js";
import { imageGenerationOperationRepository } from "../image-generation/image-generation-operation-repository.js";
import { runImageGeneration, type ImageGenerationInput } from "../image-generation/image-generation-run.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import { sendAuthorizedWorkspaceFile } from "../workspaces/workspace-file-sender.js";
import { validateWorkspacePath } from "../workspaces/workspace-path.js";
import type { WorkspaceScope } from "../workspaces/workspace-repository.js";
import { privateWorkspaceAuthorization } from "./web-app-files.js";

const DAILY_LIMIT = 20;
const NOTE_MAX = 300;
/** A run still `started` after this long lost its process: a retry may recover it from the workspace write. */
const STRANDED_AFTER_MS = 3 * 60_000;

export interface StudioRecipe {
  readonly title: string;
  readonly source: "none" | "optional" | "required";
  readonly size: ImageGenerationInput["size"];
  /** The prompt for the image model; `note` is the person's own words, or the recipe's default. */
  readonly prompt: (note: string) => string;
  readonly defaultNote: string;
}

const KEEP = "Keep the people, their faces, poses and the composition exactly as they are; no text, no watermark.";

export const STUDIO_RECIPES: Readonly<Record<string, StudioRecipe>> = {
  background: { defaultNote: "a soft autumn park", prompt: (note) => `Replace the background of this photo with ${note}, matching light and perspective. ${KEEP}`, size: "auto", source: "required", title: "Сменить фон" },
  card: { defaultNote: "a birthday card for a grandmother, watercolor, autumn flowers", prompt: (note) => `A warm greeting card illustration: ${note}. Cozy, tender, family mood. No text or letters.`, size: "1024x1536", source: "optional", title: "Открытка к поводу" },
  colorize: { defaultNote: "natural, faithful colors", prompt: (note) => `Colorize this old black-and-white photo with ${note}, restore scratches and dust gently. ${KEEP}`, size: "auto", source: "required", title: "Раскрасить старое" },
  enhance: { defaultNote: "natural light, balanced color, sharper details", prompt: (note) => `Improve this photo: ${note}. ${KEEP}`, size: "auto", source: "required", title: "Улучшить фото" },
  golden: { defaultNote: "warm golden hour sunlight", prompt: (note) => `Relight this photo with ${note}, soft long shadows and a warm glow. ${KEEP}`, size: "auto", source: "required", title: "Золотой час" },
  image: { defaultNote: "a cozy autumn house in watercolor", prompt: (note) => `${note}. High quality, gentle family mood. No text unless asked.`, size: "auto", source: "none", title: "Картинка по описанию" },
  interior: { defaultNote: "a grey sofa against the wall with soft cushions", prompt: (note) => `Place into this room ${note}, realistic scale, matching the room's light and perspective; keep the room itself unchanged. No text.`, size: "auto", source: "required", title: "Примерить в интерьере" },
  story: { defaultNote: "the same moment", prompt: (note) => `Recompose this photo into a vertical 9:16 picture for stories showing ${note}, extending the scene naturally. ${KEEP}`, size: "1024x1536", source: "required", title: "Для сторис" },
};

export function studioPrompt(recipe: StudioRecipe, note: string | undefined): string {
  const words = (note ?? "").trim();
  return recipe.prompt(words.length > 0 ? words : recipe.defaultNote);
}

/** The gallery caption in the person's language: the recipe and their own words, never the English template. */
export function studioDescription(recipe: StudioRecipe, note: string | undefined): string {
  const words = (note ?? "").trim();
  return words.length > 0 ? `${recipe.title}: ${words}` : recipe.title;
}

export interface StudioState {
  readonly state: "ambiguous" | "completed" | "failed" | "started" | "unknown";
  readonly path: string | null;
  /** The picture reached the private chat (the delivery ledger says so). */
  readonly delivered: boolean;
}

interface StoredState extends StudioState {
  readonly startedAt: Date | null;
}

function limited(): never {
  throw new AppError("AGENT_WEB_APP_STUDIO_LIMITED", "На сегодня в Студии уже много картинок. Продолжим завтра");
}

/** Counts today's Studio pictures and reserves this one under one per-workspace lock. */
export function studioReservations(): typeof imageGenerationOperationRepository {
  return {
    ...imageGenerationOperationRepository,
    async begin(input) {
      const client = await database().connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('webapp-studio:' || $1, 0))", [input.workspaceId]);
        const { rows } = await client.query<{ count: string; known: boolean }>(
          `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 day')::text AS count,
                  bool_or(operation_key = $2) AS known
             FROM image_generation_operations
            WHERE workspace_id = $1 AND operation_key LIKE 'webapp-studio:%'`,
          [input.workspaceId, input.operationKey]);
        if (rows[0]?.known !== true && Number(rows[0]?.count ?? 0) >= DAILY_LIMIT) limited();
        // The reservation rides the lock's own connection: waiting for a second one could exhaust the pool.
        const reservation = await imageGenerationOperationRepository.begin(input, client);
        await client.query("COMMIT");
        return reservation;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function bad(message = "Неверный запрос"): never {
  throw new AppError("AGENT_WEB_APP_BAD_REQUEST", message);
}

const operationKey = (auth: MemoryAuthorization, nonce: string) => `webapp-studio:${auth.userId}:${nonce}`;

export const webAppStudio = {
  /** Starts a recipe; returns at once while the picture is drawn in the background. */
  async start(
    auth: MemoryAuthorization,
    input: { note?: string; recipe: string; source?: { path: string; scope: string } },
    nonce: string,
  ): Promise<StudioState> {
    if (!IMAGE_GENERATION_AVAILABLE) throw new AppError("AGENT_IMAGE_GENERATION_UNAVAILABLE", "Рисовать картинки на этом сервере пока нельзя");
    const recipe = Object.hasOwn(STUDIO_RECIPES, input.recipe) ? STUDIO_RECIPES[input.recipe]! : bad();
    const note = input.note === undefined ? undefined : input.note.trim();
    if (note !== undefined && Array.from(note).length > NOTE_MAX) bad("Слишком длинное уточнение");
    if (recipe.source === "required" && !input.source) bad("Выберите фото");
    if (recipe.source === "none" && input.source) bad();
    if (recipe.source === "none" && !note) bad("Опишите, что нарисовать");
    const workspaceAuth = privateWorkspaceAuthorization(auth);
    const key = operationKey(auth, nonce);
    const scope: WorkspaceScope = "personal";
    const workspaceId = await workspaceBinaryRepository.workspaceId(workspaceAuth, scope);
    const existing = await stored(auth, nonce);
    const resumable = (existing.state === "completed" && !existing.delivered) || (existing.state === "started" &&
      existing.startedAt !== null && Date.now() - existing.startedAt.getTime() > STRANDED_AFTER_MS);
    if (existing.state !== "unknown" && !resumable) return publicState(existing);

    const references = [];
    let sourcePath: string | undefined;
    if (input.source) {
      if (input.source.scope !== "personal" && input.source.scope !== "family") bad();
      sourcePath = validateWorkspacePath(input.source.path);
      const read = await workspaceBinaryRepository.readBinary(workspaceAuth, input.source.scope, sourcePath);
      const mediaType = read.file.mediaType;
      if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType) || read.bytes.byteLength > 8 * 1024 * 1024) {
        bad("Нужна фотография PNG, JPEG или WebP размером до 8 МБ");
      }
      references.push({ bytes: read.bytes, mediaType: mediaType as ImageMediaType });
    }
    const imageInput: ImageGenerationInput = {
      background: "auto", description: studioDescription(recipe, note), prompt: studioPrompt(recipe, note), quality: "high", size: recipe.size,
      ...(sourcePath ? { referencePaths: [sourcePath] } : {}),
    };
    const request = { ...imageInput, ...(references.length ? { references } : {}) };
    imageGenerationClient.assertConfigured(request);
    const chatId = auth.telegramUserId!;
    // The page waits only for the reservation (the limit's answer); the picture is drawn after the response.
    let reserved!: () => void;
    let refused!: (error: unknown) => void;
    const reservation = new Promise<void>((resolve, reject) => { reserved = resolve; refused = reject; });
    const operations = studioReservations();
    const run = runImageGeneration({
      client: imageGenerationClient, workspaces: workspaceBinaryRepository,
      operations: { ...operations, begin: (value) => operations.begin(value).then((result) => { reserved(); return result; }, (error: unknown) => { refused(error); throw error; }) },
    }, { auth: workspaceAuth, input: imageInput, operationKey: key, references, request, scope, workspaceId });
    void run
      .then(({ file }) => sendAuthorizedWorkspaceFile(
        { caption: `Готово: ${recipe.title.toLowerCase()}. Ответьте на это сообщение, если поправить.`, path: file.path, presentation: "photo", scope },
        { auth: workspaceAuth, operationKey: `${key}:deliver`, projection: { applicationSessionId: null, forumTopicId: null, replyToEntryId: null },
          target: { chatId } },
      ))
      .then(() => console.info(JSON.stringify({ code: "AGENT_WEB_APP_STUDIO_DONE", recipe: input.recipe })))
      .catch((error: unknown) => {
        if (error instanceof AppError && error.code === "AGENT_WEB_APP_STUDIO_LIMITED") return;
        // A stranded run with no workspace write cannot be recovered: settle it so the page stops waiting.
        if (resumable && existing.state === "started" && error instanceof AppError && error.code === "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN") {
          void imageGenerationOperationRepository.markAmbiguous(key, error.code).catch(() => undefined);
        }
        console.error(JSON.stringify({
          code: "AGENT_WEB_APP_STUDIO_FAILED",
          errorCode: error instanceof AppError ? error.code : error instanceof Error ? error.name : "unknown",
          recipe: input.recipe,
        }));
      });
    await reservation;
    console.info(JSON.stringify({ code: resumable ? "AGENT_WEB_APP_STUDIO_RESUMED" : "AGENT_WEB_APP_STUDIO_STARTED", recipe: input.recipe }));
    return resumable ? publicState(existing) : { delivered: false, path: null, state: "started" };
  },

  async state(auth: MemoryAuthorization, nonce: string): Promise<StudioState> {
    return publicState(await stored(auth, nonce));
  },
};

function publicState({ delivered, path, state }: StoredState): StudioState {
  return { delivered, path, state };
}

async function stored(auth: MemoryAuthorization, nonce: string): Promise<StoredState> {
  const key = operationKey(auth, nonce);
  const { rows } = await database().query<{ created_at: Date; delivered: boolean; result: { path?: string } | null; status: string }>(
    `SELECT operation.status, operation.result, operation.created_at,
            EXISTS (SELECT 1 FROM workspace_file_deliveries delivery
                     WHERE delivery.operation_key = $2 AND delivery.status = 'completed') AS delivered
       FROM image_generation_operations operation WHERE operation.operation_key = $1`, [key, `${key}:deliver`]);
  const row = rows[0];
  if (!row) return { delivered: false, path: null, startedAt: null, state: "unknown" };
  const state = (["ambiguous", "completed", "failed", "started"] as const).find((value) => value === row.status) ?? "unknown";
  return { delivered: row.delivered, path: state === "completed" ? row.result?.path ?? null : null, startedAt: row.created_at, state };
}
