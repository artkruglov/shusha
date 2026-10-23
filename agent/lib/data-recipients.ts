/**
 * Кому эта установка передаёт данные людей: строка «Про данные честно» собирается из той же конфигурации, по которой
 * работает runtime, а не пишется рукой.
 *
 * Exports:
 * - `dataRecipientsLine`: одна строка для приветствия создателя семьи и приглашённого участника.
 *
 * Раньше приветствие называло Groq, хотя голос на проде распознаёт GigaAM на самом сервере, а приглашённый участник
 * про обработку не слышал вовсе (ревью приватности 23 октября 2026). Картинки и видео названы, только когда для них
 * есть ключ: без ключа инструмента нет.
 */
import type { ModelProviderConfig, ModelProviderId } from "./model-provider-config.js";

const PROVIDER_NAMES: Record<ModelProviderId, string> = {
  "codex-subscription": "OpenAI",
  deepseek: "DeepSeek",
  groq: "Groq",
  minimax: "MiniMax",
  neuraldeep: "NeuralDeep",
  "opencode-go": "OpenCode",
  openrouter: "OpenRouter",
};

type Environment = Readonly<Record<string, string | undefined>>;
const configured = (value: string | undefined) => Boolean(value?.trim());

export function dataRecipientsLine(config: Pick<ModelProviderConfig, "provider" | "voice">, environment: Environment): string {
  const parts = [`текст и фото обрабатывает языковая модель ${PROVIDER_NAMES[config.provider]}`];
  if (config.voice.enabled) {
    parts.push(config.voice.provider === "gigaam" ? "голосовые распознаются на самом сервере" : "голосовые распознаёт сервис Groq");
  }
  const media = [
    configured(environment.OPENROUTER_IMAGE_API_KEY) && configured(environment.OPENROUTER_IMAGE_MODEL) ? "картинки" : null,
    configured(environment.OPENROUTER_VIDEO_API_KEY) ? "видео" : null,
  ].filter((part): part is string => part !== null);
  if (media.length > 0) parts.push(`${media.join(" и ")} по вашей просьбе делает OpenRouter`);
  return `Про данные честно: ${parts.join(", ")}. Это не сквозное шифрование, владелец сервиса технически может видеть данные.`;
}
