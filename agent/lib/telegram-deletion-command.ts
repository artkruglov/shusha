/**
 * `/delete_me` and `/delete_family`: a person erases themselves, an owner erases the family, without the model.
 *
 * Exports:
 * - `DeletionCommandDependencies`: the family's name and the two erasures, injected for tests.
 * - `handleDeletionCommand`: consumes either command in a private chat before Eve; false for any other message.
 *
 * Key constructs:
 * - The command alone only says what will be erased and how to confirm; the erasure needs the same command with
 *   «подтверждаю» typed by the person. The confirmation is built here, from the command, not by the model.
 * - Rights are read again inside the erasing transaction (`family-deletion-repository.ts`): an owner who lost the
 *   role between the two messages, or a member removed meanwhile, is refused.
 */
import type { TelegramContext, TelegramMessage } from "eve/channels/telegram";

import { isAppError } from "./app-error.js";
import { database } from "./database.js";
import { withSystemDatabaseContext } from "./database-context.js";
import type { FamilyIdentity } from "./family-access.js";
import { familyDeletionRepository } from "./family-deletion-repository.js";

const DELETION_COMMAND_PATTERN = /^\/(delete_me|delete_family)(?:@\w+)?(?:\s+(.+))?$/u;
const CONFIRMATION = "подтверждаю";

export interface DeletionCommandDependencies {
  deleteFamily(input: { familyId: string; ownerUserId: string }): Promise<{ members: number }>;
  deleteMember(input: { familyId: string; userId: string }): Promise<void>;
  family(familyId: string): Promise<{ members: number; name: string }>;
}

const productionDependencies: DeletionCommandDependencies = {
  deleteFamily: (input) => familyDeletionRepository.deleteFamily(input),
  deleteMember: (input) => familyDeletionRepository.deleteMember(input),
  async family(familyId) {
    const result = await withSystemDatabaseContext(() => database().query<{ members: number; name: string }>(
      `SELECT f.name, (SELECT count(*) FROM family_memberships m WHERE m.family_id = f.id)::int AS members
         FROM families f WHERE f.id = $1`,
      [familyId],
    ));
    return result.rows[0] ?? { members: 0, name: "" };
  },
};

function explanation(command: "delete_family" | "delete_me", family: { members: number; name: string }): string {
  if (command === "delete_me") {
    return [
      `Это удалит вас из семьи «${family.name}» вместе с вашими данными: личные дела, личную память и историю нашего личного чата.`,
      "Общие дела, которые были на вас, станут ничьими. Семейные записи останутся у семьи, без вашего имени.",
      "Вернуть удалённое нельзя.",
      "",
      `Чтобы подтвердить, отправьте: /delete_me ${CONFIRMATION}`,
    ].join("\n");
  }
  return [
    `Это удалит семью «${family.name}» целиком: участников (${family.members}), дела, память, подключённые группы и историю чатов.`,
    "Вернуть удалённое нельзя.",
    "",
    `Чтобы подтвердить, отправьте: /delete_family ${CONFIRMATION}`,
  ].join("\n");
}

export async function handleDeletionCommand(
  input: { ctx: TelegramContext; identity: FamilyIdentity | null; message: TelegramMessage },
  dependencies: DeletionCommandDependencies = productionDependencies,
): Promise<boolean> {
  const match = DELETION_COMMAND_PATTERN.exec(input.message.text.trim());
  if (!match || !input.identity || input.message.chat.type !== "private") return false;
  const command = match[1] as "delete_family" | "delete_me";
  const identity = input.identity;
  const say = (text: string) => input.ctx.telegram.sendMessage(text);
  if (command === "delete_family" && identity.role !== "owner") {
    await say("Удалить семью может только её владелец. Удалить только себя: /delete_me");
    return true;
  }
  if (command === "delete_me" && identity.role === "owner") {
    await say("Владелец не может уйти сам: семья останется без владельца. Удалить семью целиком: /delete_family");
    return true;
  }
  if ((match[2] ?? "").trim().toLowerCase() !== CONFIRMATION) {
    await say(explanation(command, await dependencies.family(identity.familyId)));
    return true;
  }
  try {
    if (command === "delete_me") {
      await dependencies.deleteMember({ familyId: identity.familyId, userId: identity.userId });
      console.info(JSON.stringify({ code: "AGENT_MEMBER_DELETED_SELF" }));
      await say("Готово: вас и ваших данных здесь больше нет. Вернуться можно по новому приглашению владельца.");
    } else {
      const { members } = await dependencies.deleteFamily({ familyId: identity.familyId, ownerUserId: identity.userId });
      console.info(JSON.stringify({ code: "AGENT_FAMILY_DELETED", members }));
      await say("Готово: семья и все её данные удалены.");
    }
  } catch (error) {
    const code = isAppError(error) ? error.code : "AGENT_DELETION_FAILED";
    console.error(JSON.stringify({ code: "AGENT_DELETION_FAILED", command, errorCode: code }));
    await say(isAppError(error)
      ? error.message.replace(/^AGENT_[A-Z_]+: /u, "")
      : "Не получилось удалить, ничего не изменилось. Напишите оператору: /feedback не получилось удалить.");
  }
  return true;
}
