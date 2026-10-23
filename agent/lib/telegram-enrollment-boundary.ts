/**
 * Telegram owner bootstrap and invitation deep-link boundary.
 *
 * Exports:
 * - `handleTelegramEnrollmentBoundary`: consumes enrollment-only private messages before Eve.
 *
 * Key constructs:
 * - Bootstrap claims accept only the exact one-time `/start <43-character-code>` command.
 * - Invitation claims and existing-member deep links never become ordinary model turns.
 * - `/signup` (operator), `/feedback`, `/export`, `/delete_me` and `/delete_family` (owner) are answered here,
 *   without the model.
 */
import type { TelegramContext, TelegramMessage } from "eve/channels/telegram";

import { dataRecipientsLine } from "./data-recipients.js";
import { modelProviderConfig } from "./model-provider-config.js";
import { handleDeletionCommand } from "./telegram-deletion-command.js";
import { webAppUrl } from "./web-app/web-app-menu.js";
import { handleExportCommand } from "./telegram-export-command.js";
import { handleFeedbackCommand } from "./telegram-feedback-command.js";
import { readTelegramAgentIdentity } from "./telegram-agent-identity.js";
import { notifyOperatorWaitlist, notifyOwnerMemberJoined, notifyWaitlistPerson } from "./telegram-delivery.js";
import { familyChatLink } from "./groups-availability.js";
import { firstStepsKeyboard, sendOnboardingCards } from "./onboarding-cards.js";
import { telegramProfileName } from "./telegram-on-message-context.js";
import type { TelegramMessageRepositories } from "./telegram-on-message-repositories.js";

const OWNER_BOOTSTRAP_COMMAND_PATTERN = /^\/start ([A-Za-z0-9_-]{43})$/u;
// Просто Start или Start со словом ссылки: вход новой семьи (`signup_settings`).
const SIGNUP_START_PATTERN = /^\/start(?:@\w+)?(?: ([A-Za-z0-9_-]{1,64}))?$/u;
const SIGNUP_COMMAND_PATTERN = /^\/signup(?:@\w+)?(?:\s+(.*))?$/u;

export /**
 * Первое сообщение принятому участнику (стайлгайд 17.10, §3.9): три фразы, которые сразу работают, и
 * честная строка о семейной группе. Анкеты и серии обучающих сообщений нет: лучше один успешный
 * сценарий, чем каталог возможностей.
 */
// Each person who joins hears who processes what they write, not only the one who created the family.
const invitationWelcome = () => [
  "Вы в семье. Я помогаю записывать дела и видеть, что уже принято и сделано.",
  "",
  "Попробуйте кнопкой внизу или своими словами, текстом или голосом.",
  "",
  "В семейной группе я вижу сообщения участников, поэтому личное лучше писать сюда.",
  "",
  dataRecipientsLine(modelProviderConfig, process.env),
].join("\n");

const newFamilyText = () => [
  "семейный помощник: веду общие дела, напоминаю, помню договорённости.",
  "Напишите, что нужно, например: «купить молоко и напомнить завтра в 9».",
  // Who gets the data is read from the configuration the runtime works by (`data-recipients.ts`).
  dataRecipientsLine(modelProviderConfig, process.env),
  "Выгрузить свои данные: /export. Удалить себя: /delete_me, всю семью: /delete_family. Написать нам: /feedback.",
].join("\n\n");

/** Карточка новой семьи плюс ссылка, которая добавляет бота в группу и сразу подключает её (`/start@бот family`). */
function newFamilyWelcome(): string {
  // The privacy page lives next to the Mini App (`infra/public/privacy.html`); without a public address there is no link.
  const app = webAppUrl();
  // The installation's name, not a fixed one: the bot moves from Шуша to Юна by its environment alone.
  const welcome = `Я ${readTelegramAgentIdentity().name}, ${newFamilyText()}`;
  const card = app === null ? welcome : `${welcome} Подробно: ${new URL("/privacy", app).toString()}`;
  return familyChatLink(process.env.TELEGRAM_BOT_USERNAME) === null
    ? card
    : `${card}\n\nЕсть общий чат с близкими? Подключите его кнопкой ниже: кто пишет в нём, сразу попадает в семью.`;
}

/** Первые фразы: каждая кнопка даёт настоящий результат с подтверждением, а не справку. */
const OWNER_FIRST_STEPS = ["Напомни завтра в 9 купить молоко", "Добавь в покупки хлеб и яблоки", "Пригласи близкого в семью"];
const MEMBER_FIRST_STEPS = ["Напомни завтра в 9 купить молоко", "Добавь в покупки хлеб и яблоки", "Что у семьи на сегодня?"];

/** Карточки, приветствие (у владельца с кнопкой семейного чата) и кнопки первых шагов, по одному сообщению. */
async function welcome(telegram: Parameters<typeof handleTelegramEnrollmentBoundary>[0]["ctx"]["telegram"], text: string, owner: boolean) {
  await sendOnboardingCards(telegram);
  const chat = owner ? familyChatLink(process.env.TELEGRAM_BOT_USERNAME) : null;
  await telegram.sendMessage(chat === null ? text : { reply_markup: { inline_keyboard: [[{ text: "Подключить семейный чат", url: chat }]] }, text });
  await telegram.sendMessage({ reply_markup: firstStepsKeyboard(owner ? OWNER_FIRST_STEPS : MEMBER_FIRST_STEPS), text: "С чего начнём?" });
}

function describeSignup(status: { families: number; isOpen: boolean; maxFamilies: number; waiting: number; word: string | null }): string {
  const queue = status.waiting > 0 ? ` В очереди: ${status.waiting}.` : "";
  if (!status.isOpen) return `Вход закрыт. Семей: ${status.families}.${queue}`;
  const word = status.word === null ? "без слова" : `слово: ${status.word}`;
  return `Вход открыт: семей ${status.families} из ${status.maxFamilies}, ${word}.${queue}`;
}

/** Команда оператора /signup: статус, `open <число> [слово]`, `close`. Только владелец самой ранней семьи в личке. */
async function handleSignupCommand(input: Parameters<typeof handleTelegramEnrollmentBoundary>[0]): Promise<boolean> {
  const arguments_ = SIGNUP_COMMAND_PATTERN.exec(input.message.text.trim());
  if (!arguments_ || !input.identity || input.message.chat.type !== "private") return false;
  const { signup } = input.repositories;
  if (input.identity.role !== "owner" || !(await signup.isOperatorFamily(input.identity.familyId))) {
    await input.ctx.telegram.sendMessage("AGENT_SIGNUP_FORBIDDEN: Вход в сервис настраивает только оператор установки.");
    return true;
  }
  const [action, count, word] = (arguments_[1] ?? "").trim().split(/\s+/u);
  try {
    if (!action) {
      await input.ctx.telegram.sendMessage(describeSignup(await signup.status()));
    } else if (action === "close") {
      await input.ctx.telegram.sendMessage(describeSignup(await signup.update({ isOpen: false })));
    } else if (action === "open" && count !== undefined && /^\d{1,4}$/u.test(count)) {
      const status = await signup.update({ isOpen: true, maxFamilies: Number(count), word: word ?? null });
      // Расширили набор: первым по очереди уходит «места появились», и только им хватает мест.
      const batch = await signup.takeWaitlistBatch();
      const results = await Promise.all(batch.ids.map(async (id) => ({ id, ok: await notifyWaitlistPerson(id, batch.word) })));
      // Не дошедшее сообщение возвращает человека в очередь: резерв за ним не держится.
      for (const failed of results.filter((result) => !result.ok)) await signup.releaseWaitlistNotice(failed.id);
      const notified = results.filter((result) => result.ok).length;
      const queue = notified > 0 ? ` Из очереди позвала: ${notified}.` : "";
      await input.ctx.telegram.sendMessage(describeSignup({ ...status, waiting: Math.max(status.waiting - notified, 0) }) + queue);
    } else {
      await input.ctx.telegram.sendMessage("Команды: /signup, /signup open <число семей> [слово], /signup close");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.ctx.telegram.sendMessage(message.replace(/^[A-Z_]+: /u, ""));
  }
  return true;
}

type TelegramIdentity = Awaited<ReturnType<TelegramMessageRepositories["telegram"]["findIdentity"]>>;

export async function handleTelegramEnrollmentBoundary(input: {
  ctx: TelegramContext;
  identity: TelegramIdentity;
  invitationCode: string | null;
  message: TelegramMessage;
  repositories: Pick<TelegramMessageRepositories, "family" | "feedback" | "signup" | "telegram">;
}): Promise<boolean> {
  if (await handleSignupCommand(input)) return true;
  if (await handleFeedbackCommand(input, input.repositories.feedback)) return true;
  if (await handleExportCommand(input)) return true;
  if (await handleDeletionCommand(input)) return true;
  // Invitation secrets are channel commands, not conversation content, even for existing members.
  if (input.identity && input.invitationCode) {
    await input.ctx.telegram.sendMessage(
      "AGENT_INVITATION_NOT_APPLICABLE: Вы уже подключены к семейному агенту.",
    );
    return true;
  }
  if (input.identity || input.message.chat.type !== "private") return false;

  const sender = input.message.from;
  if (!sender) {
    throw new Error(
      "AGENT_TELEGRAM_ENROLLMENT_SENDER_MISSING: Telegram не передал отправителя команды подключения",
    );
  }
  const ownerConfigured = await input.repositories.telegram.hasOwner();

  // Bootstrap plaintext is consumed entirely at the channel boundary and never reaches Eve.
  if (!ownerConfigured) {
    const code = input.message.text.trim().match(OWNER_BOOTSTRAP_COMMAND_PATTERN)?.[1];
    if (!code) {
      await input.ctx.telegram.sendMessage(
        "AGENT_BOOTSTRAP_COMMAND_INVALID: Откройте одноразовую ссылку владельца, полученную на сервере.",
      );
      return true;
    }
    const claim = await input.repositories.telegram.claimFirstOwner(code, {
      displayName: telegramProfileName(input.message),
      telegramUserId: sender.id,
      ...(sender.username ? { username: sender.username } : {}),
    });
    if (claim === "claimed") {
      await input.ctx.telegram.sendMessage("Владелец создан. Семейный агент готов к настройке.");
      return true;
    }
    await input.ctx.telegram.sendMessage(
      "AGENT_BOOTSTRAP_CODE_INVALID: Код недействителен или истек. Создайте новый код на сервере.",
    );
    return true;
  }

  // A one-time `--new-family` code starts one more family next to the existing ones; the plaintext never reaches Eve.
  const newFamilyCode = input.message.text.trim().match(OWNER_BOOTSTRAP_COMMAND_PATTERN)?.[1];
  if (newFamilyCode) {
    const claim = await input.repositories.telegram.claimNewFamily(newFamilyCode, {
      displayName: telegramProfileName(input.message),
      telegramUserId: sender.id,
      ...(sender.username ? { username: sender.username } : {}),
    });
    if (claim === "claimed") {
      // The one-time server code gets the same welcome as the shared link: it used to be a single bare line.
      await welcome(input.ctx.telegram, newFamilyWelcome(), true);
      return true;
    }
    await input.ctx.telegram.sendMessage(
      "AGENT_BOOTSTRAP_CODE_INVALID: Код недействителен или истёк. Попросите новый у того, кто вас пригласил.",
    );
    return true;
  }

  // Only a strict Telegram deep-link command can enter the invitation verifier.
  if (input.invitationCode) {
    const claim = await input.repositories.family.claimInvitation(input.invitationCode, {
      displayName: telegramProfileName(input.message),
      telegramUserId: sender.id,
      ...(sender.username ? { username: sender.username } : {}),
    });
    if (typeof claim === "object") {
      const name = telegramProfileName(input.message);
      await welcome(input.ctx.telegram, invitationWelcome(), false);
      await notifyOwnerMemberJoined({ memberName: name, ownerTelegramUserId: claim.joined.ownerTelegramUserId });
      return true;
    }
    if (claim === "pending") {
      await input.ctx.telegram.sendMessage(
        "AGENT_INVITATION_PENDING: Заявка отправлена владельцу. Доступ появится после подтверждения.",
      );
      return true;
    }
  }

  // Просто Start или Start со словом ссылки: семья по общей ссылке, если оператор открыл вход.
  // Ссылка-приглашение, которая не подошла, семьи не создаёт: человек хотел в чужую.
  const signupStart = input.invitationCode ? null : SIGNUP_START_PATTERN.exec(input.message.text.trim());
  if (signupStart) {
    const claim = await input.repositories.signup.claimSelfServeFamily(signupStart[1] ?? null, {
      displayName: telegramProfileName(input.message),
      telegramUserId: sender.id,
      ...(sender.username ? { username: sender.username } : {}),
    });
    if (claim === "claimed") {
      await welcome(input.ctx.telegram, newFamilyWelcome(), true);
      return true;
    }
    if (claim === "full") {
      await input.repositories.signup.joinWaitlist({
        displayName: telegramProfileName(input.message),
        telegramUserId: sender.id,
      });
      await input.ctx.telegram.sendMessage("Сейчас места закончились. Я запомнила вас и напишу первой, когда набор расширят.");
      return true;
    }
  }

  // Без приглашения в закрытую Юну не входят, но и не получают «нет доступа»: человек встаёт в очередь,
  // а оператор один раз узнаёт о нём и решает, кого пустить (пост о наборе первых семей, 23 октября 2026).
  const name = telegramProfileName(input.message);
  const queued = await input.repositories.signup.joinWaitlist({ displayName: name, telegramUserId: sender.id });
  await input.ctx.telegram.sendMessage(CLOSED_ENTRANCE_TEXT);
  if (queued) {
    const operator = await input.repositories.signup.operatorTelegramUserId();
    if (operator && operator !== sender.id) {
      await notifyOperatorWaitlist({ name, operatorTelegramUserId: operator, ...(sender.username ? { username: sender.username } : {}) });
    }
  }
  return true;
}

const CLOSED_ENTRANCE_TEXT = [
  "Юна пока живёт в закрытом кругу: сюда приходят только по личному приглашению 🤫",
  "",
  "Я записала вас в список гостей. Как только для вашей семьи освободится место, напишу первой.",
  "",
  "Если вас кто-то позвал, откройте ссылку из его приглашения — и я сразу вас впущу.",
].join("\n");
