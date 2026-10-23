/**
 * Подсказки из Mini App в чат и флаги возможностей для каталога «Умеет».
 *
 * Exports:
 * - `WEB_APP_HINTS`: id подсказки → текст, который бот пришлёт в личку.
 * - `WebAppCapabilities`, `webAppCapabilities`: что из каталога доступно на этом сервере.
 * - `HintThrottle`, `createHintThrottle`: предел подсказок на человека.
 *
 * Нажатие «Попросить в чате» не запускает ход модели и не пишет за человека: бот без модели присылает ему в личку
 * пример фразы или команду, а отправляет её сам человек. Текст берётся только отсюда, по id; страница присылает id,
 * а не текст, поэтому через неё нельзя заставить бота написать что-то своё. Флаги те же, что открывают инструменты
 * (`trusted-mode-tool-catalog.ts`): пункт каталога, для которого инструмента нет, страница не показывает. Имя бота с
 * падежами страница тоже берёт отсюда (`TELEGRAM_AGENT_NAME` установки), а не держит у себя.
 */
import { GOOGLE_WORKSPACE_AVAILABLE } from "../google-workspace/google-workspace-availability.js";
import { GROCERY_AVAILABLE } from "../grocery/grocery-config.js";
import { WEB_APP_GROUPS_ENABLED } from "../groups-availability.js";
import { readTelegramAgentIdentity, type TelegramAgentNameCases } from "../telegram-agent-identity.js";
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";
import { VIDEO_GENERATION_AVAILABLE } from "../video-generation/video-generation-availability.js";

/** Сколько подсказок за сутки на человека: больше не нажимают, а чат не должен стать лентой подсказок. */
const HINTS_PER_DAY = 30;
const HINT_GAP_MS = 2_000;

const example = (phrase: string) => `Напишите мне, например:\n«${phrase}»`;

export const WEB_APP_HINTS: Readonly<Record<string, string>> = {
  "cmd-delete-me": "Чтобы удалить свои данные, отправьте: /delete_me\nЯ сначала объясню, что удалится, и попрошу подтвердить.",
  "cmd-export": "Чтобы выгрузить свои данные файлом, отправьте: /export",
  "cmd-feedback": "Чтобы написать разработчику, отправьте: /feedback и ваш текст одним сообщением.",
  "coach-on": example("Включи вопросы коуча"),
  "connect-google": example("Подключи Google"),
  "family-area": example("Заведи область заботы «Машина»: ТО, шины, страховка"),
  "family-decision": "Совместное решение предлагается в семейной группе. Напишите там, например:\n«Предлагаю: в воскресенье идём в парк»",
  "family-invite": example("Пригласи в семью маму"),
  "family-idea-project": "Чтобы идея стала проектом, назовите первый шаг, например:\n«Керамику — в проект, первый шаг: найти студию рядом»",
  "family-tradition": example("Предлагаю традицию: настолки по средам вечером"),
  "grocery-cart": example("Собери корзину ВкусВилла по списку покупок"),
  "memory-edit": "Чтобы исправить сведение, напишите мне, что именно изменить, например:\n«Исправь: удобное время для напоминаний — после 20:00»",
  "skill-animate": example("Оживи это фото: пусть камера медленно приближается"),
  "studio-animate": "Пришлите фото и напишите:\n«Оживи это фото: камера медленно наезжает, 5 секунд»",
  "studio-background": "Пришлите фото и напишите:\n«Замени фон на осенний парк»",
  "studio-card": example("Нарисуй открытку бабушке Ирине на день рождения, акварель"),
  "studio-colorize": "Пришлите фото и напишите:\n«Раскрась это старое фото, аккуратно и естественно»",
  "studio-enhance": "Пришлите фото и напишите:\n«Улучши это фото: свет, цвет, чёткость»",
  "studio-golden": "Пришлите фото и напишите:\n«Сделай на этом фото свет золотого часа»",
  "studio-image": example("Нарисуй уютный осенний дом в стиле акварели"),
  "studio-interior": "Пришлите фото и напишите:\n«Поставь в эту комнату серый диван у стены, мягкий свет»",
  "studio-story": "Пришлите фото и напишите:\n«Сделай из этого фото вертикальную картинку для сторис 9:16»",
  "skill-browser": example("Открой сайт поликлиники и посмотри свободные часы на субботу"),
  "skill-calendar": example("Поставь встречу во вторник в 12:00 с Антоном"),
  "skill-care-area": example("Машина теперь на мне целиком: техосмотр, шины, страховка"),
  "skill-coach": example("Давай вопросы коуча раз в пару дней"),
  "skill-compare": example("Подбери проектор в детскую до 30 тысяч, со ссылками и отзывами"),
  "skill-decision": example("Предложи семье: в воскресенье идём в парк"),
  "skill-diet-cart": example("Собери во ВкусВилле продукты на неделю: около 120 г белка в день"),
  "skill-doc": example("Сделай документ Word с планом переезда"),
  "skill-drive": example("Найди на Диске договор аренды"),
  "skill-errand": example("Подбери три кружка робототехники рядом с домом и отправь жене"),
  "skill-explain": example("Объясни ребёнку 9 лет, как образовался космос"),
  "skill-homework": "Пришлите фото домашней работы и напишите, например:\n«Проверь домашку, где ошибки и что повторить?»",
  "skill-image": example("Нарисуй уютный дом в стиле акварели"),
  "skill-mail": example("Найди в почте письмо от школы на этой неделе"),
  "skill-overview": example("Присылай утреннюю сводку в 8:00"),
  "skill-personal-time": example("По средам с 19 до 21 у меня личное время, не пиши и не ставь дела"),
  "skill-photo-edit": "Пришлите фото комнаты и напишите, например:\n«Поставь сюда серый диван у стены»",
  "skill-remember": example("Запомни: у сына аллергия на арахис"),
  "skill-reminder": example("Напомни завтра в 19:00 забрать посылку"),
  "skill-reminder-weekly": example("Напоминай по понедельникам в 10:00 оплатить кружок"),
  "skill-routine": example("Каждое утро в 8:00 присылай новости и погоду"),
  "skill-search": example("Во сколько сегодня открыт планетарий?"),
  "skill-sheet": example("Сделай таблицу Excel с расходами на ремонт"),
  "skill-shopping": example("Добавь в покупки молоко, хлеб и яйца"),
  "skill-skill": example("Научись делать меню на неделю в моём стиле"),
  "skill-summary": example("Собери саммари всего, что я сегодня надиктовал"),
  "skill-task-assign": example("Попроси жену забрать посылку завтра"),
  "skill-task-project": example("Заведи проект «Переезд»: шторы, матрас, перевезти вещи"),
  "skill-task-repeat": example("Каждую пятницу поливать цветы"),
  "skill-task-unowned": example("Кто-нибудь, вынесите мусор сегодня"),
  "skill-task-voice": "Запишите голосовое со всеми делами подряд — я разберу их по одному.",
  "skill-text": example("Напиши объявление на Профи.ру о переезде по этой смете"),
  "skill-weekly-review": example("Включи обзор недели по воскресеньям"),
  "skill-what-know": example("Что ты обо мне знаешь?"),
};

export interface WebAppCapabilities {
  /** Как зовут бота на этой установке; у незнакомого имени во всех падежах именительный. */
  readonly agent: { readonly cases: TelegramAgentNameCases; readonly name: string };
  readonly google: boolean;
  readonly grocery: boolean;
  /** «Группы» (MVP-1) за флагом `WEB_APP_GROUPS_ENABLED`. */
  readonly groups: boolean;
  readonly images: boolean;
  readonly video: boolean;
}

export function webAppCapabilities(): WebAppCapabilities {
  const identity = readTelegramAgentIdentity();
  return {
    agent: { cases: identity.cases, name: identity.name },
    google: GOOGLE_WORKSPACE_AVAILABLE, grocery: GROCERY_AVAILABLE, groups: WEB_APP_GROUPS_ENABLED,
    images: IMAGE_GENERATION_AVAILABLE, video: VIDEO_GENERATION_AVAILABLE,
  };
}

export interface HintThrottle {
  /** True when this person may get one more hint now; counts it. */
  take(userId: string, now: Date): boolean;
}

/** In process memory: one agent process serves the Mini App, and a lost count after a restart costs nothing. */
export function createHintThrottle(): HintThrottle {
  const seen = new Map<string, { day: string; count: number; last: number }>();
  return {
    take(userId, now) {
      const day = now.toISOString().slice(0, 10);
      const entry = seen.get(userId);
      const current = entry && entry.day === day ? entry : { count: 0, day, last: 0 };
      if (current.count >= HINTS_PER_DAY || now.getTime() - current.last < HINT_GAP_MS) return false;
      seen.set(userId, { count: current.count + 1, day, last: now.getTime() });
      return true;
    },
  };
}
