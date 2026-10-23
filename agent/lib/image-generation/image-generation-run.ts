/**
 * One billable image generation into a workspace, exactly once per operation key: the core of `generate_image`,
 * shared with the Mini App Studio (`web-app-studio.ts`), which runs a recipe without a model turn.
 *
 * Exports:
 * - `ImageGenerationRunDependencies`: provider client, operation ledger and workspace binary storage.
 * - `ImageGenerationInput`: what is drawn (prompt, size, quality, background, caption, reference paths).
 * - `imageOutputPath`: the stable, non-overwriting path stem for an operation key.
 * - `runImageGeneration`: reserve, generate, save, complete — or replay what an earlier call with the key did.
 *
 * Key constructs:
 * - One durable reservation precedes the billable provider call; no failure is retried implicitly.
 * - A started operation found again is recovered from the workspace write it made, never generated twice.
 */
import { createHash } from "node:crypto";

import { AppError, isAppError } from "../app-error.js";
import type { ImageGenerationRequest, ImageMediaType } from "./image-generation-client.js";
import type { ImageGenerationReservation } from "./image-generation-operation-repository.js";
import type { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import type { WorkspaceAuthorization, WorkspaceScope } from "../workspaces/workspace-repository.js";
import type { WorkspaceFileRecord } from "../workspaces/workspace-file-record.js";

export interface ImageGenerationInput {
  background: "auto" | "opaque" | "transparent";
  caption?: string | undefined;
  /** The gallery's caption when the prompt is not words a person wrote (the Studio's English templates). */
  description?: string | undefined;
  prompt: string;
  quality: "auto" | "high" | "low" | "medium";
  referenceAttachmentIds?: string[] | undefined;
  referencePaths?: string[] | undefined;
  size: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
}

export interface ImageGenerationRunDependencies {
  client: {
    assertConfigured(input?: ImageGenerationRequest): void;
    generate(input: ImageGenerationRequest): Promise<{
      bytes: Buffer;
      mediaType: ImageMediaType;
      model: string;
      revisedPrompt?: string;
    }>;
  };
  operations: {
    begin(input: {
      description?: string;
      inputHash: string;
      operationKey: string;
      outputPath: string;
      workspaceId: string;
    }): Promise<ImageGenerationReservation>;
    complete(operationKey: string, file: WorkspaceFileRecord): Promise<void>;
    markAmbiguous(operationKey: string, errorCode: string): Promise<void>;
    markFailed(operationKey: string, errorCode: string): Promise<void>;
  };
  workspaces: {
    readBinary: typeof workspaceBinaryRepository.readBinary;
    findBinaryWrite(
      auth: WorkspaceAuthorization,
      scope: WorkspaceScope,
      operationKey: string,
    ): Promise<WorkspaceFileRecord | null>;
    workspaceId(auth: WorkspaceAuthorization, scope: WorkspaceScope): Promise<string>;
    writeBinary(auth: WorkspaceAuthorization, input: {
      bytes: Uint8Array;
      mediaType: string;
      operationKey: string;
      path: string;
      scope: WorkspaceScope;
    }): Promise<WorkspaceFileRecord>;
  };
}

const OUTPUT_EXTENSIONS: Readonly<Record<ImageMediaType, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** The ledger records the extension-free stem: the provider that answers decides the format. */
export function imageOutputPath(operationKey: string): string {
  const digest = createHash("sha256").update(operationKey, "utf8").digest("hex").slice(0, 24);
  return `generated-images/image-${digest}`;
}

function outputFilePath(stem: string, mediaType: ImageMediaType): string {
  return `${stem}.${OUTPUT_EXTENSIONS[mediaType]}`;
}

function inputHash(input: ImageGenerationInput, scope: WorkspaceScope, references?: ImageGenerationRequest["references"]): string {
  return createHash("sha256").update(JSON.stringify({
    background: input.background,
    prompt: input.prompt,
    quality: input.quality,
    scope,
    size: input.size,
    ...(references?.length ? { references: references.map((reference, index) => ({
      source: input.referencePaths?.[index] ?? input.referenceAttachmentIds?.[index],
      sha256: createHash("sha256").update(reference.bytes).digest("hex"),
    })) } : {}),
  }), "utf8").digest("hex");
}

function assertOutputMatches(
  file: WorkspaceFileRecord,
  scope: WorkspaceScope,
  expectedPath: string,
): void {
  if (
    file.scope === scope &&
    file.mediaType in OUTPUT_EXTENSIONS &&
    file.path === outputFilePath(expectedPath, file.mediaType as ImageMediaType)
  ) return;
  throw new AppError(
    "AGENT_IMAGE_GENERATION_REPLAY_MISMATCH",
    "Сохранённое изображение не совпадает с исходным запросом. Создайте новый запрос",
  );
}

function terminalReservationError(reservation: Extract<
  ImageGenerationReservation,
  { state: "ambiguous" | "failed" }
>): AppError {
  if (reservation.state === "ambiguous") {
    return new AppError(
      "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
      "Не удалось подтвердить прошлую генерацию. Не повторяйте её без нового запроса",
    );
  }
  return new AppError(
    reservation.errorCode,
    "Прошлая генерация завершилась ошибкой. Создайте новый запрос",
  );
}

async function settleProviderFailure(
  dependencies: ImageGenerationRunDependencies,
  operationKey: string,
  error: unknown,
): Promise<never> {
  const definitive = isAppError(error) && [
    "AGENT_IMAGE_GENERATION_CONFIG_INVALID",
    "AGENT_IMAGE_GENERATION_REJECTED",
  ].includes(error.code);
  const errorCode = isAppError(error) ? error.code : "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN";
  try {
    if (definitive) await dependencies.operations.markFailed(operationKey, errorCode);
    else await dependencies.operations.markAmbiguous(operationKey, errorCode);
  } catch (ledgerError) {
    console.error(JSON.stringify({
      code: "AGENT_IMAGE_GENERATION_LEDGER_SETTLEMENT_FAILED",
      error: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
      operationKey,
      providerErrorCode: errorCode,
    }));
  }
  if (isAppError(error)) throw error;
  throw new AppError(
    "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
    "Не удалось подтвердить результат генерации изображения. Не повторяйте запрос сразу",
  );
}

async function recoverStartedOperation(
  dependencies: ImageGenerationRunDependencies,
  auth: WorkspaceAuthorization,
  scope: WorkspaceScope,
  operationKey: string,
  expectedPath: string,
): Promise<WorkspaceFileRecord> {
  const replay = await dependencies.workspaces.findBinaryWrite(auth, scope, operationKey);
  if (!replay) {
    throw new AppError(
      "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
      "Не удалось подтвердить прошлую генерацию. Не повторяйте её без нового запроса",
    );
  }
  assertOutputMatches(replay, scope, expectedPath);
  await dependencies.operations.complete(operationKey, replay);
  return replay;
}

export async function runImageGeneration(
  dependencies: ImageGenerationRunDependencies,
  run: {
    auth: WorkspaceAuthorization;
    input: ImageGenerationInput;
    operationKey: string;
    references: NonNullable<ImageGenerationRequest["references"]>;
    request: ImageGenerationRequest;
    scope: WorkspaceScope;
    workspaceId: string;
  },
): Promise<{ file: WorkspaceFileRecord; generated: boolean; model: string; revisedPrompt?: string }> {
  const { auth, input, operationKey, references, request, scope, workspaceId } = run;
  const path = imageOutputPath(operationKey);
  const reservation = await dependencies.operations.begin({
    description: input.description ?? input.prompt,
    inputHash: inputHash(input, scope, references),
    operationKey: operationKey,
    outputPath: path,
    workspaceId,
  });

  let file: WorkspaceFileRecord;
  let generated = false;
  let generatedModel = "stored";
  let revisedPrompt: string | undefined;
  if (reservation.state === "completed") {
    file = reservation.file;
    assertOutputMatches(file, scope, path);
  } else if (reservation.state === "started") {
    file = await recoverStartedOperation(dependencies, auth, scope, operationKey, path);
  } else if (reservation.state === "failed" || reservation.state === "ambiguous") {
    throw terminalReservationError(reservation);
  } else {
    let generatedImage: Awaited<ReturnType<ImageGenerationRunDependencies["client"]["generate"]>>;
    try {
      generatedImage = await dependencies.client.generate(request);
    } catch (error) {
      return await settleProviderFailure(dependencies, operationKey, error);
    }
    try {
      file = await dependencies.workspaces.writeBinary(auth, {
        bytes: generatedImage.bytes,
        mediaType: generatedImage.mediaType,
        operationKey: operationKey,
        path: outputFilePath(path, generatedImage.mediaType),
        scope,
      });
    } catch (error) {
      console.error(JSON.stringify({
        code: "AGENT_IMAGE_GENERATION_PERSISTENCE_FAILED",
        error: error instanceof Error ? error.message : String(error),
        operationKey: operationKey,
      }));
      try {
        await dependencies.operations.markAmbiguous(
          operationKey,
          "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
        );
      } catch (ledgerError) {
        console.error(JSON.stringify({
          code: "AGENT_IMAGE_GENERATION_LEDGER_SETTLEMENT_FAILED",
          error: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
          operationKey: operationKey,
        }));
      }
      throw new AppError(
        "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
        "Изображение было создано, но его сохранение не подтверждено. Не повторяйте запрос сразу",
      );
    }
    try {
      await dependencies.operations.complete(operationKey, file);
    } catch (error) {
      // The workspace operation is durable, so retaining `started` lets exact-call replay recover it.
      console.error(JSON.stringify({
        code: "AGENT_IMAGE_GENERATION_LEDGER_COMPLETION_FAILED",
        error: error instanceof Error ? error.message : String(error),
        operationKey: operationKey,
      }));
      throw new AppError(
        "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
        "Изображение создано и сохранено, но завершение операции не подтверждено. Не повторяйте запрос сразу",
      );
    }
    generated = true;
    generatedModel = generatedImage.model;
    revisedPrompt = generatedImage.revisedPrompt;
  }

  return { file, generated, model: generatedModel, ...(revisedPrompt === undefined ? {} : { revisedPrompt }) };
}
