/**
 * Проверенный ввод инструмента проектов: идентичность и область берёт репозиторий, не модель.
 *
 * Exports:
 * - `projectInput`, `ProjectInput`: действия над проектом области.
 *
 * Проект это результат из нескольких шагов (GTD): у него есть название, необязательное описание
 * результата, сфера жизни и дела внутри. Срока у проекта нет, срок живёт у его дел.
 */
import { z } from "zod";

import { LIFE_AREAS } from "../life-areas.js";

const date = z.iso.date().refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Укажите существующую календарную дату");

const FIELDS: Record<string, readonly string[]> = {
  cancel: ["id", "version"],
  complete: ["id", "version"],
  create: ["title", "details", "lifeArea", "nextStep"],
  list: ["includeClosed"],
  merge: ["id", "intoId", "version"],
  reopen: ["id", "version"],
  update: ["id", "version", "title", "details", "lifeArea"],
};

export const projectInput = z.object({
  action: z.enum(["list", "create", "update", "complete", "cancel", "reopen", "merge"]),
  details: z.string().trim().min(1).max(1000).nullable().optional(),
  id: z.uuid().optional(),
  includeClosed: z.boolean().optional(),
  intoId: z.uuid().optional(),
  lifeArea: z.enum(LIFE_AREAS).nullable().optional(),
  /** Первое действие проекта: у проекта без следующего шага смысла нет, и он создаётся вместе с ним. */
  nextStep: z.object({
    dueOn: date.optional(),
    title: z.string().trim().min(1).max(500),
  }).strict().optional(),
  title: z.string().trim().min(1).max(100).optional(),
  version: z.number().int().positive().optional(),
}).strict().superRefine((value, context) => {
  const allowed = new Set(FIELDS[value.action]);
  for (const key of Object.keys(value)) {
    if (key !== "action" && !allowed.has(key)) {
      context.addIssue({ code: "custom", message: `Поле ${key} не относится к действию ${value.action}` });
    }
  }
  if (value.action === "create" && !value.title) context.addIssue({ code: "custom", message: "Для create нужно название" });
  if (["update", "complete", "cancel", "reopen", "merge"].includes(value.action) && (!value.id || value.version === undefined)) {
    context.addIssue({ code: "custom", message: "Нужны id и version из list" });
  }
  if (value.action === "update" && !["title", "details", "lifeArea"].some((key) => key in value)) {
    context.addIssue({ code: "custom", message: "Укажите изменения" });
  }
  if (value.action === "merge" && (!value.intoId || value.intoId === value.id)) {
    context.addIssue({ code: "custom", message: "Для merge нужен intoId другого проекта" });
  }
});

export type ProjectInput = z.infer<typeof projectInput>;
