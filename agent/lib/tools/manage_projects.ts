/**
 * Проекты: результат из нескольких шагов, у которого есть следующее действие (GTD).
 *
 * Описание уходит в доверенные режимы, и только здесь заводится новый проект: имя списка у дела находит
 * существующий (`findNamedProject`). Во внешней группе инструмента нет, там имя по-прежнему заводит проект.
 */
import { defineTool } from "eve/tools";

import { requireMemoryAuthorization } from "../memory-context.js";
import { projectInput } from "../projects/project-contract.js";
import { projectRepository } from "../projects/project-repository.js";

export default defineTool({
  description: [
    "Проекты: результат из нескольких шагов.",
    "list: id, version, open, completed, hasNextStep. create: title, details, lifeArea, nextStep {title, dueOn} создаёт первое дело сразу, повтор имени не дублирует.",
    "Дело входит в существующий проект своим listName; create только после «да» человека. update, complete (без открытых дел), cancel (отвязывает дела), reopen, merge {id, intoId}: id и version из list.",
    "Общий проект меняй после вопроса второму.",
  ].join(" "),
  inputSchema: projectInput,
  async execute(input, ctx) {
    return projectRepository.execute(requireMemoryAuthorization(ctx), input, `${ctx.session.id}:${ctx.callId}`);
  },
});
