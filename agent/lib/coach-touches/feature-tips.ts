/**
 * «Фишка»: одна возможность, которую человек ещё не пробовал, и короткий путь попробовать её сразу.
 *
 * Экспорт:
 * - `FeatureTip`, `FEATURE_TIPS`: каталог советов с постоянными номерами (номер хранит кнопка, миграция 195).
 * - `FeatureAvailability`: что включено на этом сервере; приходит снаружи, каталог флаги не читает.
 * - `featureTipByNumber`: совет по номеру из кнопки.
 * - `selectFeatureTip`: какой совет показать человеку, или null.
 * - `formatFeatureTip`, `FEATURE_TIP_LABELS`, `FEATURE_TIP_FIRST_LINE`: текст сообщения и подписи кнопок.
 *
 * Владелец, 21 октября 2026: люди пользовались тремя возможностями из пятнадцати, о домашке по фото и оживлении
 * снимка никто не знал. Совет начинается с жизненной ситуации, а не с названия функции, говорит, что получится, и
 * под ним кнопка «Попробовать», которая присылает конкретную фразу или просьбу прислать фото. Только то, что есть на
 * самом деле: монтажа видео и живой камеры нет, и каталог их не обещает. Совет о коже прямо говорит, что это не
 * диагноз.
 *
 * Порядок выбора: доступно на этом сервере, ещё не показывалось, возможность ещё не пробовали. Советы о фото
 * (домашка, «что это?», кожа) после первого фото тоже имеют смысл, это разные поводы, поэтому каждый из них может
 * прийти один раз, но только когда непробованное кончилось. Порядок каталога и есть приоритет.
 */
import type { FeatureKey } from "../feature-uses/feature-catalog.js";

export type FeatureAvailabilityFlag = "google" | "grocery" | "images" | "video";
export type FeatureAvailability = Readonly<Record<FeatureAvailabilityFlag, boolean>>;

export interface FeatureTip {
  /** Постоянный номер: его держит кнопка; не менять и не переиспользовать. */
  readonly number: number;
  /** Ключ в `feature_tip_shows.tip_id`. */
  readonly id: string;
  readonly feature: FeatureKey;
  /** Флаг сервера, без которого совета нет; null — возможность есть всегда. */
  readonly requires: FeatureAvailabilityFlag | null;
  /** Совет о фото: может прийти и после первого фото, когда непробованное кончилось. */
  readonly photoBased: boolean;
  readonly text: string;
  /** Что бот пришлёт по «Попробовать». */
  readonly tryText: string;
}

export const FEATURE_TIPS: readonly FeatureTip[] = [
  {
    number: 1, id: "homework", feature: "photo", requires: null, photoBased: true,
    text: "Ребёнок сделал домашку, а проверить некогда? Пришлите фото — найду ошибки и объясню, что повторить. Решать за ребёнка не буду, только подскажу, где подумать ещё.",
    tryText: "Пришлите фото задания — проверю и объясню ошибки, решать за ребёнка не буду. Можно добавить класс и предмет.",
  },
  {
    number: 2, id: "voice_tasks", feature: "voice", requires: null, photoBased: false,
    text: "Некогда печатать? Надиктуйте голосовое со всеми делами подряд, хоть на ходу, — я разберу его и запишу дела по одному.",
    tryText: "Запишите голосовое: перечислите всё, что нужно сделать, в любом порядке. Я разберу и покажу, что записала.",
  },
  {
    number: 3, id: "web_search", feature: "web_search", requires: null, photoBased: false,
    text: "Нужно узнать, во сколько работает поликлиника, или что изменилось в правилах? Я ищу свежее в интернете и даю ссылки на источники.",
    tryText: "Напишите, что найти, — например: «Во сколько сегодня работает ближайший МФЦ?» Поищу и пришлю со ссылками.",
  },
  {
    number: 4, id: "reminder", feature: "reminder", requires: null, photoBased: false,
    text: "Боитесь забыть про оплату кружка или звонок маме? Скажите «напомни в пятницу в 10…» — напишу ровно в это время. Можно и каждую неделю.",
    tryText: "Напишите, о чём и когда напомнить, — например: «Напомни завтра в 19:00 забрать посылку».",
  },
  {
    number: 5, id: "request", feature: "request", requires: null, photoBased: false,
    text: "Хотите попросить кого-то из семьи что-то сделать и не напоминать по десять раз? Скажите мне — я передам просьбу, у человека будут кнопки «Беру» и «Не могу», а вы увидите ответ.",
    tryText: "Напишите, кого и о чём попросить, — например: «Попроси Сашу купить хлеб сегодня».",
  },
  {
    number: 6, id: "portrait", feature: "image", requires: "images", photoBased: false,
    text: "Нужна новая аватарка или открытка? Пришлите селфи и скажите стиль — акварель, аниме, ретро-фото — и я нарисую портрет.",
    tryText: "Пришлите селфи и напишите стиль, например: «Сделай портрет в стиле акварели».",
  },
  {
    number: 7, id: "animate_photo", feature: "video", requires: "video", photoBased: false,
    text: "Старое семейное фото можно оживить: пришлите снимок, и я сделаю короткий ролик на несколько секунд, где камера плавно движется, а люди чуть оживают.",
    tryText: "Пришлите фото и напишите, например: «Оживи это фото: камера медленно приближается». Ролик придёт сам, когда будет готов.",
  },
  {
    number: 8, id: "street_photo", feature: "photo", requires: null, photoBased: true,
    text: "Увидели на прогулке незнакомое растение, жука или странный знак? Сфотографируйте и спросите «что это?» — расскажу, что знаю.",
    tryText: "Пришлите фото и спросите: «Что это такое?»",
  },
  {
    number: 9, id: "document", feature: "document", requires: null, photoBased: false,
    text: "Пришёл длинный договор или инструкция на двадцать страниц? Пришлите файл — перескажу главное и отвечу на вопросы по нему.",
    tryText: "Пришлите документ — PDF, Word или фото страниц — и напишите, что в нём важно найти.",
  },
  {
    number: 10, id: "skin", feature: "photo", requires: null, photoBased: true,
    text: "Вскочил прыщик или появилось пятно, и непонятно, стоит ли волноваться? Пришлите фото — скажу, на что похоже и что обычно делают. Это не диагноз: при тревожных признаках нужен врач.",
    tryText: "Пришлите фото при дневном свете и напишите, что беспокоит и как давно. Скажу, на что похоже, но диагноз ставит только врач: если больно, быстро растёт, кровит или поднялась температура — к нему.",
  },
  {
    number: 11, id: "guest", feature: "guest", requires: null, photoBased: false,
    text: "Спорите в чате с друзьями, где поужинать или как правильно? Упомяните меня там через @ — отвечу прямо в той переписке. Ваши дела и память туда не попадут.",
    tryText: "Откройте любой чат, напишите @ и моё имя пользователя, а затем вопрос — например, «где поужинать в центре?». Ответ увидят все в том чате.",
  },
  {
    number: 12, id: "shopping", feature: "shopping", requires: null, photoBased: false,
    text: "Список покупок остался на холодильнике? Скажите «добавь в покупки молоко и хлеб», а в магазине спросите «что купить?». В семейной группе список общий.",
    tryText: "Напишите, что добавить в покупки, — например: «Добавь в покупки молоко, яйца и хлеб».",
  },
  {
    number: 13, id: "grocery", feature: "grocery", requires: "grocery", photoBased: false,
    text: "Закупка на неделю отнимает вечер? Скажите, что нужно, — подберу товары во ВкусВилле и пришлю ссылку на корзину. Заказ и оплата остаются за вами.",
    tryText: "Напишите, что купить, — например: «Собери во ВкусВилле продукты на завтраки на неделю».",
  },
  {
    number: 14, id: "google", feature: "google", requires: "google", photoBased: false,
    text: "Встречи и кружки живут в Google Календаре? Подключите Google — буду ставить встречи и искать письма по вашей просьбе.",
    tryText: "Напишите «Подключи Google» — пришлю ссылку для входа.",
  },
  {
    number: 15, id: "ask_anything", feature: "chat", requires: null, photoBased: false,
    text: "Меня можно просто спросить о чём угодно: что приготовить из того, что есть, как объяснить ребёнку дроби, что подарить свекрови.",
    tryText: "Спросите что-нибудь прямо сейчас — например: «Что приготовить на ужин из курицы и кабачка?»",
  },
];

export const FEATURE_TIP_LABELS = { tip_dismiss: "Не интересно", tip_try: "Попробовать", tips_off: "Не присылать советы" } as const;

/** Первый совет объясняет себя одной строкой и говорит, как выключить. */
export const FEATURE_TIP_FIRST_LINE = "Иногда буду подсказывать, что я ещё умею, — не чаще двух раз в неделю. Не нужно — нажмите «Не присылать советы».";

export function featureTipByNumber(number: number | null): FeatureTip | null {
  return FEATURE_TIPS.find((tip) => tip.number === number) ?? null;
}

export function selectFeatureTip(input: {
  availability: FeatureAvailability;
  shown: ReadonlySet<string>;
  used: ReadonlySet<FeatureKey>;
}): FeatureTip | null {
  const open = FEATURE_TIPS.filter((tip) =>
    (tip.requires === null || input.availability[tip.requires]) && !input.shown.has(tip.id));
  return open.find((tip) => !input.used.has(tip.feature))
    ?? open.find((tip) => tip.photoBased && input.used.has("photo"))
    ?? null;
}

export function formatFeatureTip(tip: FeatureTip, first: boolean): string {
  return [...(first ? [FEATURE_TIP_FIRST_LINE, ""] : []), `💡 ${tip.text}`].join("\n");
}
