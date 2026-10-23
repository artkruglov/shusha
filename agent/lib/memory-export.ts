/**
 * Personal memory export formatting.
 *
 * Exports:
 * - `MemoryExport`: versioned JSON export contract.
 * - `formatMemoryExportFiles`: produces UTF-8 JSON and readable Markdown documents. The `/export` command
 *   adds the person's open tasks and requests; the model's tool exports memory alone.
 */
import type { MemoryItem } from "./memory-record.js";

/** A task as the person's board shows it: the list row, without another person's private details. */
export interface ExportedTask {
  dueAt: string | null;
  dueOn: string | null;
  id?: string;
  kind: string;
  listName: string | null;
  source: string;
  status: string;
  title: string;
}

export interface MemoryExport {
  exportedAt: string;
  records: readonly MemoryItem[];
  schemaVersion: 1;
  tasks?: readonly ExportedTask[];
  /** The person's own requests that others have not answered yet. */
  waiting?: readonly ExportedTask[];
}

function taskLines(title: string, tasks: readonly ExportedTask[]): string[] {
  if (tasks.length === 0) return [];
  return [`## ${title}`, "", ...tasks.map((task) => {
    const due = task.dueAt ?? task.dueOn;
    return `- ${task.title.replace(/\s+/gu, " ")} (${task.source}${task.listName ? `, ${task.listName}` : ""}` +
      `${due ? `, срок ${due}` : ""}, ${task.status})`;
  }), ""];
}

function quoteMarkdown(value: string): string {
  return value.split("\n").map((line) => `> ${line}`).join("\n");
}

export function formatMemoryExportFiles(memoryExport: MemoryExport): {
  json: string;
  markdown: string;
} {
  const markdownRecords = memoryExport.records.map((record, index) => [
    `## ${index + 1}. ${record.kind}`,
    "",
    `- ID: \`${record.id}\``,
    `- Область: \`${record.scope}\``,
    `- Создано: ${record.createdAt}`,
    `- Обновлено: ${record.updatedAt}`,
    `- Подтверждение: \`${record.confirmation}\``,
    `- Чувствительность: \`${record.sensitivity}\``,
    "",
    quoteMarkdown(record.content),
  ].join("\n"));
  return {
    json: `${JSON.stringify(memoryExport, null, 2)}\n`,
    markdown: [
      "# Экспорт личной памяти Osinara",
      "",
      `Дата экспорта: ${memoryExport.exportedAt}`,
      `Количество записей: ${memoryExport.records.length}`,
      "",
      ...taskLines("Открытые дела", memoryExport.tasks ?? []),
      ...taskLines("Жду ответа", memoryExport.waiting ?? []),
      ...markdownRecords,
      "",
    ].join("\n"),
  };
}
