/**
 * Telegram proof that the owner administers a group before it is bound to a family.
 *
 * Exports:
 * - `TelegramGroupAdminVerifier`: the check registration runs after HITL approval.
 * - `createTelegramGroupAdminVerifier`: injectable verifier on one bounded `getChatMember` call.
 * - `telegramGroupAdminVerifier`: lazy production verifier on the required bot token.
 *
 * Key construct:
 * - Registration binds a chat id the model passed to the owner's family. Knowing the id of a chat
 *   the bot sits in is not ownership of it, so Telegram must answer that the verified owner is the
 *   creator or an administrator there (security review 5 October 2026). Every other answer refuses:
 *   a plain member, a lookup Telegram rejects, a timeout or a malformed answer never registers.
 */
import { callTelegramApi, type TelegramApiResponse } from "eve/channels/telegram";
import { z } from "zod";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../config.js";
import { AppError } from "./app-error.js";
import { withRequestTimeout } from "./request-signal.js";

const ADMIN_STATUSES: ReadonlySet<string> = new Set(["administrator", "creator"]);
const TELEGRAM_USER_ID_PATTERN = /^[1-9][0-9]*$/u;

const chatMemberAnswerSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    status: z.string().min(1),
    user: z.object({ id: z.number().int().positive() }),
  }),
});

export interface TelegramGroupAdminVerifier {
  requireAdministrator(input: {
    signal?: AbortSignal;
    telegramChatId: string;
    telegramUserId: string;
  }): Promise<void>;
}

interface TelegramGroupAdminVerifierDependencies {
  botToken: string;
  fetch: typeof fetch;
  timeoutMilliseconds: number;
}

function requireTelegramUserId(raw: string): number {
  const id = Number(raw);
  if (!TELEGRAM_USER_ID_PATTERN.test(raw) || !Number.isSafeInteger(id)) {
    throw new AppError(
      "AGENT_TELEGRAM_GROUP_OWNER_IDENTITY_MISSING",
      "Не удалось определить ваш Telegram-аккаунт для проверки прав в группе. Группа не зарегистрирована",
    );
  }
  return id;
}

function providerDescription(body: unknown): string | null {
  const description = (body as { description?: unknown } | null)?.description;
  return typeof description === "string" ? description : null;
}

function refuseFailedLookup(response: TelegramApiResponse): never {
  // 400 and 403 are Telegram's definite answers about this chat: unknown id, bot absent or removed.
  const definite = response.status === 400 || response.status === 403;
  const code = definite
    ? "AGENT_TELEGRAM_GROUP_ADMIN_CHECK_REJECTED"
    : "AGENT_TELEGRAM_GROUP_ADMIN_CHECK_UNAVAILABLE";
  console.error(JSON.stringify({
    code,
    providerDescription: providerDescription(response.body),
    providerStatus: response.status,
  }));
  throw new AppError(
    code,
    definite
      ? "Telegram не дал проверить ваши права в этой группе: проверьте telegramChatId и что бот " +
          "состоит в группе. Группа не зарегистрирована"
      : "Telegram сейчас не ответил на проверку ваших прав в группе. Группа не зарегистрирована; " +
          "повторите позже",
  );
}

export function createTelegramGroupAdminVerifier(
  dependencies: TelegramGroupAdminVerifierDependencies,
): TelegramGroupAdminVerifier {
  if (!dependencies.botToken) throw new AppError(
    "AGENT_TELEGRAM_CONFIG_MISSING",
    "Не задан токен Telegram для проверки прав владельца в группе",
  );

  return {
    async requireAdministrator(input): Promise<void> {
      const userId = requireTelegramUserId(input.telegramUserId);
      let response: TelegramApiResponse;
      try {
        response = await callTelegramApi({
          body: { chat_id: input.telegramChatId, user_id: userId },
          botToken: dependencies.botToken,
          fetch: withRequestTimeout(dependencies.fetch, dependencies.timeoutMilliseconds, input.signal),
          method: "getChatMember",
        });
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_TELEGRAM_GROUP_ADMIN_CHECK_UNAVAILABLE",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }));
        throw new AppError(
          "AGENT_TELEGRAM_GROUP_ADMIN_CHECK_UNAVAILABLE",
          "Не удалось связаться с Telegram для проверки ваших прав в группе. Группа не " +
            "зарегистрирована; повторите позже",
        );
      }
      if (!response.ok) refuseFailedLookup(response);

      const answer = chatMemberAnswerSchema.safeParse(response.body);
      // The answer must describe exactly the owner that was asked about, or it proves nothing.
      if (!answer.success || answer.data.result.user.id !== userId) {
        console.error(JSON.stringify({
          code: "AGENT_TELEGRAM_GROUP_ADMIN_CHECK_RESPONSE_INVALID",
          providerStatus: response.status,
          userMatches: answer.success ? false : null,
        }));
        throw new AppError(
          "AGENT_TELEGRAM_GROUP_ADMIN_CHECK_RESPONSE_INVALID",
          "Telegram вернул непонятный ответ на проверку ваших прав в группе. Группа не зарегистрирована",
        );
      }
      if (!ADMIN_STATUSES.has(answer.data.result.status)) {
        console.error(JSON.stringify({
          code: "AGENT_TELEGRAM_GROUP_OWNER_NOT_ADMIN",
          memberStatus: answer.data.result.status,
        }));
        throw new AppError(
          "AGENT_TELEGRAM_GROUP_OWNER_NOT_ADMIN",
          "Зарегистрировать группу можно, только если вы её создатель или администратор в Telegram. " +
            "Назначьте себя администратором группы и повторите",
        );
      }
    },
  };
}

function productionVerifier(): TelegramGroupAdminVerifier {
  return createTelegramGroupAdminVerifier({
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    fetch,
    timeoutMilliseconds: TELEGRAM_API_REQUEST_TIMEOUT_MS,
  });
}

// Runtime secrets stay lazy so Eve discovery and build remain deterministic.
export const telegramGroupAdminVerifier: TelegramGroupAdminVerifier = {
  requireAdministrator: (input) => productionVerifier().requireAdministrator(input),
};
