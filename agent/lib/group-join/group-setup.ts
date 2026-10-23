/**
 * Подготовка только что подключённой группы («Группы», шаг 2): приветствие в закрепе и ссылка для владельца.
 *
 * Exports:
 * - `GROUP_SETUP_TEXT`: что прочитают группа и владелец.
 * - `createGroupSetup`: `prepare` после `/start@бот group` и `inviteLink` для кнопки «Позвать людей».
 * - `groupSetup`: то же на транспорте приложения.
 *
 * Ссылка всегда с заявками (`creates_join_request`): по ней человек не входит сам, а просится, и бот встречает его
 * в личке (`group-join.ts`). Выпустить её и закрепить сообщение бот может только с правами администратора;
 * без них приветствие просит эти права, а владелец получит ссылку кнопкой в приложении позже.
 */
import { readTelegramAgentIdentity } from "../telegram-agent-identity.js";
import { groupJoinTransport, type GroupJoinTransport } from "./group-join-transport.js";

export const GROUP_SETUP_TEXT = {
  needsRights: "\n\nЧтобы я закрепляла важное и встречала новых людей, сделайте меня администратором с правами приглашать и закреплять.",
  ownerLink: (title: string, link: string) =>
    `Группа «${title}» подключена.\n\nЧтобы позвать людей, перешлите им эту ссылку:\n${link}\n\n` +
    "Каждого я встречу в личке. Участников семьи пущу сама, а про остальных спрошу вас.",
  welcome: (agent: string) =>
    "Группа подключена: у неё свои дела, традиции и память. Личного и семейного она не видит.\n\n" +
    `Пишите мне прямо здесь, например: «${agent}, запиши: купить продукты» или «${agent}, какие у нас дела?».`,
} as const;

export function createGroupSetup(dependencies: { agentName(): string; transport: GroupJoinTransport }) {
  const { transport } = dependencies;
  const linkName = () => dependencies.agentName().slice(0, 32);

  return {
    /**
     * Приветствие и ссылка; каждый шаг сам по себе: без закрепа и без ссылки группа всё равно подключена.
     * Возвращает false, если даже приветствие не ушло: тогда чат получает обычный ответ команды.
     */
    async prepare(input: { ownerTelegramUserId: string; telegramChatId: string; title: string }): Promise<boolean> {
      let rights = { invite: false, pin: false };
      try {
        rights = await transport.botRights(input.telegramChatId);
      } catch (error) {
        warn("AGENT_GROUP_SETUP_RIGHTS_FAILED", error);
      }
      const welcome = GROUP_SETUP_TEXT.welcome(dependencies.agentName()) + (rights.invite && rights.pin ? "" : GROUP_SETUP_TEXT.needsRights);
      let messageId: string;
      try {
        messageId = await transport.send(input.telegramChatId, welcome);
      } catch (error) {
        warn("AGENT_GROUP_SETUP_WELCOME_FAILED", error);
        return false;
      }
      if (rights.pin) {
        try {
          await transport.pin(input.telegramChatId, messageId);
        } catch (error) {
          warn("AGENT_GROUP_SETUP_PIN_FAILED", error);
        }
      }
      if (rights.invite) {
        try {
          const link = await transport.createInviteLink(input.telegramChatId, linkName());
          await transport.send(input.ownerTelegramUserId, GROUP_SETUP_TEXT.ownerLink(input.title, link));
        } catch (error) {
          warn("AGENT_GROUP_SETUP_LINK_FAILED", error);
        }
      }
      console.info(JSON.stringify({ code: "AGENT_GROUP_SETUP_DONE", invite: rights.invite, pin: rights.pin }));
      return true;
    },

    /** Новая ссылка с заявками или null, если у бота нет права приглашать. */
    async inviteLink(telegramChatId: string): Promise<string | null> {
      const rights = await transport.botRights(telegramChatId);
      if (!rights.invite) return null;
      return await transport.createInviteLink(telegramChatId, linkName());
    },
  };
}

function warn(code: string, error: unknown): void {
  console.warn(JSON.stringify({ code, error: error instanceof Error ? error.message : String(error) }));
}

export const groupSetup = createGroupSetup({
  agentName: () => readTelegramAgentIdentity().name,
  transport: groupJoinTransport,
});
