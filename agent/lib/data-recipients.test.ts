/**
 * Строка о получателях данных: модель текста из конфигурации, голос на сервере или у Groq, картинки и видео только с
 * ключом. Проверяется и то, что строки, написанной рукой, больше нет: приветствие говорит то же, что делает runtime.
 */
import { describe, expect, it } from "vitest";

import { dataRecipientsLine } from "./data-recipients.js";

describe("data recipients line", () => {
  it("names the text model and says local speech stays on the server", () => {
    const line = dataRecipientsLine({ provider: "deepseek", voice: { enabled: true, provider: "gigaam", transcriptionModelId: "multilingual_ctc" } }, {});
    expect(line).toBe("Про данные честно: текст и фото обрабатывает языковая модель DeepSeek, голосовые распознаются на самом сервере. "
      + "Это не сквозное шифрование, владелец сервиса технически может видеть данные.");
    expect(line).not.toContain("Groq");
  });

  it("names Groq for cloud speech and OpenRouter only for the media that has a key", () => {
    const line = dataRecipientsLine({ provider: "deepseek", voice: { enabled: true, transcriptionModelId: "whisper-large-v3-turbo" } },
      { OPENROUTER_IMAGE_API_KEY: "k", OPENROUTER_IMAGE_MODEL: "m", OPENROUTER_VIDEO_API_KEY: " " });
    expect(line).toContain("голосовые распознаёт сервис Groq");
    expect(line).toContain("картинки по вашей просьбе делает OpenRouter");
    expect(line).not.toContain("видео");
  });

  it("does not mention speech when voice is off", () => {
    expect(dataRecipientsLine({ provider: "openrouter", voice: { enabled: false } }, {})).not.toMatch(/голос/u);
  });
});
