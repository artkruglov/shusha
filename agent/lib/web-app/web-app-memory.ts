/**
 * «Что бот обо мне помнит» в Mini App: личные сведения человека, их источник и удаление.
 *
 * Exports:
 * - `WebAppMemoryItem`, `WebAppMemoryPage`, `WebAppMemorySource`: то, что получает страница.
 * - `webAppMemory`: список, источник и мягкое удаление через `memoryRepository` и `memorySourceRepository`,
 *   как инструменты `list_memories`, `get_memory_source` и `manage_memory`.
 *
 * Все вызовы идут с правами, суженными до `personal`: страница показывает и меняет только личное, а семейная
 * запись, даже если её ссылку подставить руками, отвергается самим репозиторием. Удаление мягкое
 * (`deleted_at`), как в чате. Источник читается по требованию, а не для каждой карточки сразу.
 *
 * Правки здесь нет: `updateByRef` требует источник новой формулировки, сообщение журнала переписки, а у
 * нажатия в приложении его нет. «Изменить» отправляет человека в чат, где исправление получает свой источник.
 */
import type { MemoryAuthorization } from "../memory-context.js";
import { memoryRepository } from "../memory-repository.js";
import { memorySourceRepository } from "../memory-source-repository.js";
import { toModelMemory } from "../model-memory.js";

const PAGE_SIZE = 50;

export interface WebAppMemoryItem {
  readonly ref: string;
  readonly content: string;
  readonly kind: string;
  /** Дата последнего подтверждённого изменения. */
  readonly at: string;
}

export interface WebAppMemoryPage {
  readonly items: readonly WebAppMemoryItem[];
  readonly nextCursor: string | null;
}

export interface WebAppMemorySource {
  readonly author: string;
  readonly chat: string;
  readonly observedAt: string;
  readonly snippet: string;
  readonly link: string | null;
}

function personalOnly(auth: MemoryAuthorization): MemoryAuthorization {
  return { ...auth, scopes: ["personal"] };
}

export const webAppMemory = {
  async list(auth: MemoryAuthorization, cursor: string | undefined): Promise<WebAppMemoryPage> {
    const page = await memoryRepository.list(personalOnly(auth), { limit: PAGE_SIZE, scope: "personal", ...(cursor ? { cursor } : {}) });
    return {
      items: page.items.map((item) => {
        const memory = toModelMemory(item);
        return { at: memory.updatedAt ?? memory.createdAt, content: memory.content, kind: memory.kind, ref: memory.memoryRef };
      }),
      nextCursor: page.nextCursor,
    };
  },

  async source(auth: MemoryAuthorization, ref: string): Promise<WebAppMemorySource> {
    const source = await memorySourceRepository.lookup(personalOnly(auth), ref);
    return {
      author: source.sourceAuthorLabel, chat: source.originChatLabel, link: source.telegramLink ?? null,
      observedAt: source.observedAt, snippet: source.evidenceSnippet,
    };
  },

  async remove(auth: MemoryAuthorization, ref: string, operationKey: string): Promise<void> {
    await memoryRepository.deleteByRef(personalOnly(auth), ref, operationKey);
  },
};
