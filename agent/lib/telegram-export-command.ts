/**
 * `/export`: the person's memory and open tasks as files in their private chat, without the model.
 *
 * Exports:
 * - `ExportCommandDependencies`, `exportCommandDependencies`: authorization, reading and delivery; the
 *   production ones on the application database and Telegram.
 * - `handleExportCommand`: consumes the command in a private chat before Eve; false for any other message.
 *
 * Key constructs:
 * - The rights are those of the person's own private chat (`privateChatAuthorization`), read live, inside
 *   the family's row-level scope: the export holds exactly what the person could read in that chat.
 * - The same ledger as the model's `export_memory` (`memory-export-repository.ts`) keyed by the message:
 *   Telegram redelivering the same update does not send the files twice, and a delivery that may have
 *   reached the chat is not repeated automatically.
 */
import type { TelegramContext, TelegramMessage } from "eve/channels/telegram";

import { isAppError } from "./app-error.js";
import { withFamilyDatabaseContext } from "./database-context.js";
import type { FamilyIdentity } from "./family-access.js";
import { dailyOverviewRepository } from "./initiative/daily-overview-repository.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { formatMemoryExportFiles, type ExportedTask } from "./memory-export.js";
import { memoryExportRepository } from "./memory-export-repository.js";
import type { MemoryItem } from "./memory-record.js";
import { privateChatAuthorization, productionTaskButtonAuthorizer } from "./task-buttons/task-button-authorization.js";
import { deliverMemoryExportFiles } from "./telegram-memory-export-delivery.js";

const EXPORT_COMMAND_PATTERN = /^\/export(?:@\w+)?$/u;

export interface ExportCommandDependencies {
  authorize(identity: FamilyIdentity, telegramUserId: string): Promise<MemoryAuthorization>;
  begin(auth: MemoryAuthorization, operationKey: string): Promise<MemoryItem[]>;
  complete(auth: MemoryAuthorization, operationKey: string): Promise<void>;
  deliver(input: { chatId: string; json: string; markdown: string }): Promise<void>;
  fail(auth: MemoryAuthorization, operationKey: string, code: string): Promise<void>;
  tasks(auth: MemoryAuthorization): Promise<{ tasks: ExportedTask[]; waiting: ExportedTask[] }>;
}

function exported(task: ExportedTask): ExportedTask {
  return {
    dueAt: task.dueAt, dueOn: task.dueOn, ...(task.id ? { id: task.id } : {}), kind: task.kind,
    listName: task.listName, source: task.source, status: task.status, title: task.title,
  };
}

export const exportCommandDependencies: ExportCommandDependencies = {
  authorize: (identity, telegramUserId) => privateChatAuthorization(identity, telegramUserId, productionTaskButtonAuthorizer),
  begin: (auth, key) => memoryExportRepository.begin(auth, key),
  complete: (auth, key) => memoryExportRepository.complete(auth, key),
  deliver: (input) => deliverMemoryExportFiles(input),
  fail: (auth, key, code) => memoryExportRepository.fail(auth, key, code),
  async tasks(auth) {
    // The board the person sees in the chat, read by their own identity; the timezone does not matter here.
    const overview = await dailyOverviewRepository.overview({
      familyId: auth.familyId, settings: { timezone: "UTC" }, telegramUserId: auth.telegramUserId!, userId: auth.userId!,
    });
    return { tasks: overview.tasks.map(exported), waiting: overview.waiting.map(exported) };
  },
};

export async function handleExportCommand(
  input: { ctx: TelegramContext; identity: FamilyIdentity | null; message: TelegramMessage },
  dependencies: ExportCommandDependencies = exportCommandDependencies,
): Promise<boolean> {
  const sender = input.message.from;
  if (!EXPORT_COMMAND_PATTERN.test(input.message.text.trim()) || !input.identity || !sender ||
    input.message.chat.type !== "private") return false;
  const identity = input.identity;
  const operationKey = `command-export:${input.message.chat.id}:${input.message.messageId}`;
  try {
    await withFamilyDatabaseContext(identity.familyId, async () => {
      const auth = await dependencies.authorize(identity, sender.id);
      const records = await dependencies.begin(auth, operationKey);
      const { tasks, waiting } = await dependencies.tasks(auth);
      const files = formatMemoryExportFiles({ exportedAt: new Date().toISOString(), records, schemaVersion: 1, tasks, waiting });
      try {
        await dependencies.deliver({ chatId: input.message.chat.id, ...files });
      } catch (error) {
        // A refusal is definitive; a network failure stays started, so the files are never sent twice.
        if (isAppError(error) && error.code === "AGENT_MEMORY_EXPORT_DELIVERY_FAILED") {
          await dependencies.fail(auth, operationKey, error.code);
        }
        throw error;
      }
      await dependencies.complete(auth, operationKey);
      console.info(JSON.stringify({ code: "AGENT_EXPORT_DELIVERED", records: records.length, tasks: tasks.length }));
    });
  } catch (error) {
    const code = isAppError(error) ? error.code : "AGENT_EXPORT_FAILED";
    console.error(JSON.stringify({ code: "AGENT_EXPORT_FAILED", errorCode: code }));
    // An already delivered export is silent: the redelivered update finds the files in the chat.
    if (code !== "AGENT_MEMORY_EXPORT_ALREADY_DELIVERED") {
      await input.ctx.telegram.sendMessage(isAppError(error)
        ? error.message.replace(/^AGENT_[A-Z_]+: /u, "")
        : "Не получилось собрать выгрузку. Попробуйте позже.");
    }
  }
  return true;
}
