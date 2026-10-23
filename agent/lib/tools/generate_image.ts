/**
 * Subscription-backed raster image generation tool.
 *
 * Exports:
 * - `createGenerateImageTool`: dependency-injected exact-once generation and delivery workflow.
 * - Default `generate_image`: production Eve tool using CLIProxyAPI, workspace, and Telegram.
 *
 * Key constructs:
 * - The verified workspace scope and call ID determine a stable non-overwriting output path.
 * - One durable reservation precedes the billable provider call; no failure is retried implicitly
 *   (`image-generation-run.ts`, shared with the Mini App Studio).
 * - A completed image is delivered through the existing exact-once Telegram file sender.
 */
import { defineTool, type ToolContext, type ToolDefinition } from "eve/tools";
import { z } from "zod";
import { fileTypeFromBuffer } from "file-type";
import { readImageReferenceAttachment } from "../image-generation/image-reference-attachment.js";

import { AppError, isAppError } from "../app-error.js";
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";
import {
  imageGenerationClient,
  type ImageGenerationRequest,
  type ImageMediaType,
} from "../image-generation/image-generation-client.js";
import { imageGenerationOperationRepository } from "../image-generation/image-generation-operation-repository.js";
import { runImageGeneration, type ImageGenerationRunDependencies } from "../image-generation/image-generation-run.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import type { WorkspaceAuthorization, WorkspaceScope } from "../workspaces/workspace-repository.js";
import type { WorkspaceFileRecord } from "../workspaces/workspace-file-record.js";
import sendWorkspaceFile from "./send_workspace_file.js";

type AnyToolDefinition = ToolDefinition<any, any>;

interface GenerateImageDependencies extends ImageGenerationRunDependencies {
  readAttachment?: typeof readImageReferenceAttachment;
  deliver(input: {
    caption?: string;
    path: string;
    presentation: "photo";
    scope: WorkspaceScope;
  }, ctx: ToolContext): Promise<unknown>;
}

const IMAGE_PROMPT_MAX_LENGTH = 8_000;
const IMAGE_CAPTION_MAX_LENGTH = 1_024;
const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536", "auto"] as const;
const IMAGE_QUALITIES = ["low", "medium", "high", "auto"] as const;
const IMAGE_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;

const inputSchema = z.object({
  referenceAttachmentIds: z.array(z.string().uuid()).min(1).max(4).optional()
    .describe("Для фотографий из группового журнала: attachmentId из текущего чата. Не смешивай с referencePaths"),
  referencePaths: z.array(z.string().min(1).max(500)).min(1).max(4).optional()
    .describe("Для редактирования: пути от 1 до 4 исходных изображений в workspace текущего чата, в порядке ролей в prompt"),
  background: z.enum(IMAGE_BACKGROUNDS).describe("transparent, opaque или auto"),
  caption: z.string().min(1).max(IMAGE_CAPTION_MAX_LENGTH).optional()
    .describe("Необязательная подпись к отправленному изображению"),
  prompt: z.string().min(1).max(IMAGE_PROMPT_MAX_LENGTH)
    .describe("Полная визуальная спецификация изображения без служебных инструкций"),
  quality: z.enum(IMAGE_QUALITIES).describe("low, medium, high или auto"),
  size: z.enum(IMAGE_SIZES).describe("1024x1024, 1536x1024, 1024x1536 или auto"),
}).strict().refine(input => !(input.referencePaths && input.referenceAttachmentIds),
  {message:"Передайте referencePaths или referenceAttachmentIds, не оба"});

type GenerateImageInput = z.infer<typeof inputSchema>;

function parseInput(input: unknown): GenerateImageInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "AGENT_IMAGE_GENERATION_INPUT_INVALID",
      "Не удалось проверить параметры изображения. Уточните описание и формат",
    );
  }
  return parsed.data;
}

function currentWorkspaceScope(auth: WorkspaceAuthorization): WorkspaceScope {
  if (auth.telegramChatType === "private" && auth.userId !== null) return "personal";
  if (auth.telegramChatType !== "private" && auth.groupId !== null) {
    if (auth.groupType === "family_private") return "family";
    if (auth.groupType === "external") return "group";
  }
  throw new AppError(
    "AGENT_WORKSPACE_CONTEXT_INVALID",
    "Не удалось определить область для сохранения изображения",
  );
}

export function createGenerateImageTool(dependencies: GenerateImageDependencies): AnyToolDefinition {
  return defineTool({
    description: [
      "Создать изображение или отредактировать фотографию через referencePaths и отправить результат в текущий Telegram-чат. Редактирование требует OpenRouter image provider.",
      "Не использовать для SVG, диаграмм из кода или незапрошенной фоновой генерации. Исходный файл сохраняется.",
      "Вход: prompt описывает назначение, сцену, объект, композицию, стиль и запреты. Если размер или качество не заданы пользователем, передай auto.",
      "Результат: изображение сохраняется без перезаписи в generated-images и доставляется как photo; returned path можно использовать в следующих запросах.",
      "Ошибка: status unknown означает возможное списание лимита провайдера; не повторяй вызов автоматически. Надписи, особенно кириллицу, модели рисуют плохо, предупреждай об этом.",
    ].join(" "),
    inputSchema,
    async execute(rawInput, ctx) {
      // The mode surfaces never emit this descriptor without the subscription provider, so reaching
      // execution means a stale descriptor. Fail before the durable reservation records a call that
      // could never have been billed.
      if (!IMAGE_GENERATION_AVAILABLE) {
        throw new AppError(
          "AGENT_IMAGE_GENERATION_UNAVAILABLE",
          "Генерация изображений недоступна: не настроен ни один провайдер",
        );
      }
      const input = parseInput(rawInput);
      const auth = requireWorkspaceAuthorization(ctx);
      const scope = currentWorkspaceScope(auth);
      dependencies.client.assertConfigured();
      const workspaceId = await dependencies.workspaces.workspaceId(auth, scope);
      const references: NonNullable<ImageGenerationRequest["references"]> = [];
      for (const sourceId of input.referencePaths ?? input.referenceAttachmentIds ?? []) {
        const bytes = input.referencePaths
          ? (await dependencies.workspaces.readBinary(auth, scope, sourceId)).bytes
          : await (dependencies.readAttachment ?? readImageReferenceAttachment)(auth, sourceId);
        const detected = bytes.length <= 8 * 1024 * 1024
          ? await fileTypeFromBuffer(bytes) : undefined;
        if (!detected || !["image/png", "image/jpeg", "image/webp"].includes(detected.mime)) {
          throw new AppError("AGENT_IMAGE_REFERENCE_INVALID", "Нужна фотография PNG, JPEG или WebP размером до 8 МБ");
        }
        references.push({bytes, mediaType: detected.mime as ImageMediaType});
      }
      const request: ImageGenerationRequest = { ...input,
        ...(references.length ? {references} : {}),
      };
      dependencies.client.assertConfigured(request);
      const { file, generated, model: generatedModel, revisedPrompt } = await runImageGeneration(dependencies, {
        auth, input, operationKey: ctx.callId, references, request, scope, workspaceId,
      });

      const delivery = await dependencies.deliver({
        ...(input.caption === undefined ? {} : { caption: input.caption }),
        path: file.path,
        presentation: "photo",
        scope,
      }, ctx) as Record<string, unknown>;
      return {
        ...delivery,
        generated,
        model: generatedModel,
        path: file.path,
        ...(revisedPrompt === undefined ? {} : { revisedPrompt }),
      };
    },
  }) as AnyToolDefinition;
}

export default createGenerateImageTool({
  client: imageGenerationClient,
  deliver: (input, ctx) => (sendWorkspaceFile as AnyToolDefinition).execute(input, ctx),
  operations: imageGenerationOperationRepository,
  workspaces: workspaceBinaryRepository,
});
