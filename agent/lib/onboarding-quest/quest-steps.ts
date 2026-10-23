/**
 * «Знакомство с Юной»: восемь первых шагов, их признаки по данным и тексты, которые пишет код.
 *
 * Экспорт:
 * - `QuestStep`, `QUEST_STEPS`: шаги с постоянными номерами (номер держит кнопка «Попробовать» и имя карточки).
 * - `QuestFacts`, `QuestAvailability`: что известно о человеке из базы и что есть на этом сервере.
 * - `questStepByNumber`, `availableQuestSteps`, `doneQuestSteps`, `nextQuestStep`: выбор шага.
 * - `QUEST_DAYS`, `QUEST_TOUCH_DAYS`, `dueQuestTouch`: сколько длится знакомство и в какие дни касание.
 * - `QUEST_TEXT`, `successCaption`, `touchCaption`, `questCardFile`: подписи карточек и ответы кнопок.
 *
 * Дизайн: docs/service/pm/onboarding-quest.ru.md (23 октября 2026). Шаг засчитывается по данным, не по словам модели:
 * `done` это чистая функция над фактами (`quest-repository.ts`), сам признак читается живым запросом. Шаг, которого нет
 * на сервере (нет ключа картинок, нет семейного чата), из квеста выпадает, а не висит непройденным, поэтому номер шага
 * в тексте не пишется: «3 из 7» считается по доступным. Покупки остаются всегда: список покупок есть на любой
 * установке, корзина ВкусВилла только меняет фразу.
 */
import type { FeatureKey } from "../feature-uses/feature-catalog.js";

export interface QuestFacts {
  /** Голосовое распознано, и в те же минуты человек записал дело. */
  readonly voiceTask: boolean;
  /** Взрослых в семье (метка родства не «child»). */
  readonly adults: number;
  /** У семьи зарегистрирован семейный чат. */
  readonly familyGroup: boolean;
  /** Что человек уже попробовал (`feature-use-repository.ts`), включая `group_task`. */
  readonly used: ReadonlySet<FeatureKey>;
}

export interface QuestAvailability {
  /** Семейный чат можно подключить: у бота есть имя для ссылки. */
  readonly familyChat: boolean;
  readonly grocery: boolean;
  readonly images: boolean;
}

export interface QuestStep {
  /** Постоянный номер: карточка `quest-<номер>.jpg` и `tip_number` кнопки; не менять. */
  readonly number: number;
  /** Ключ в `onboarding_quest_marks.mark`. */
  readonly id: string;
  /** «Дальше — …»: что за шаг и что получится. */
  readonly title: string;
  /** Шаг владельца: приглашает и подключает чат только он; участнику этот шаг не предлагается и не считается. */
  readonly ownerOnly: boolean;
  readonly requires: keyof QuestAvailability | null;
  /** Что ответить на «Попробовать». */
  readonly howTo: string;
  /** Готовая фраза кнопкой внизу; null — шаг делается не текстом в личке (голос, фото, чат). */
  phrase(availability: QuestAvailability): string | null;
  done(facts: QuestFacts): boolean;
}

const fixed = (text: string | null) => () => text;

export const QUEST_STEPS: readonly QuestStep[] = [
  {
    number: 1, id: "voice", ownerOnly: false, requires: null,
    title: "голосом: надиктуйте дела на неделю",
    howTo: "Нажмите микрофон справа внизу и расскажите планы на неделю как есть: праздник у Сони, подарок бабушке, список к поездке. Я разберу и запишу дела по одному.",
    phrase: fixed(null),
    done: (facts) => facts.voiceTask,
  },
  {
    number: 2, id: "family", ownerOnly: true, requires: null,
    title: "семья: позовите близкого",
    howTo: "Нажмите кнопку внизу — пришлю ссылку-приглашение. Перешлите её близкому, и у вас будут общие дела.",
    phrase: fixed("Пригласи близкого в семью"),
    done: (facts) => facts.adults >= 2,
  },
  {
    number: 3, id: "family_chat", ownerOnly: true, requires: "familyChat",
    title: "семейный чат: подключите общий чат",
    howTo: "Нажмите «Подключить семейный чат» и выберите ваш общий чат — я приду туда сразу с нужными правами.",
    phrase: fixed(null),
    done: (facts) => facts.familyGroup,
  },
  {
    number: 4, id: "group_task", ownerOnly: false, requires: "familyChat",
    title: "общее дело: возьмите его в чате",
    howTo: "Напишите в семейном чате общее дело, например «Купить торт к субботе». Под ним будет кнопка «Беру» — кто возьмётся, нажмёт, и все это увидят.",
    phrase: fixed(null),
    done: (facts) => facts.used.has("group_task"),
  },
  {
    number: 5, id: "photo", ownerOnly: false, requires: null,
    title: "фото: спросите, что на снимке",
    howTo: "Сфотографируйте что угодно — растение на прогулке, этикетку, открытку — и спросите «что это?». Расскажу, что вижу.",
    phrase: fixed(null),
    done: (facts) => facts.used.has("photo"),
  },
  {
    number: 6, id: "image", ownerOnly: false, requires: "images",
    title: "картинка: нарисую открытку",
    howTo: "Нажмите кнопку внизу или опишите свою картинку — нарисую за минуту.",
    phrase: fixed("Нарисуй открытку для бабушки"),
    done: (facts) => facts.used.has("image"),
  },
  {
    number: 7, id: "web_search", ownerOnly: false, requires: null,
    title: "интернет: найду, где поужинать",
    howTo: "Нажмите кнопку внизу — поищу свежее в интернете и пришлю со ссылками. Можно добавить район.",
    phrase: fixed("Где поужинать с детьми рядом?"),
    done: (facts) => facts.used.has("web_search"),
  },
  {
    number: 8, id: "shopping", ownerOnly: false, requires: null,
    title: "покупки: соберу продукты на борщ",
    howTo: "Нажмите кнопку внизу — соберу список продуктов, а в магазине спросите «что купить?».",
    phrase: (availability) => availability.grocery ? "Собери во ВкусВилле продукты на борщ" : "Собери продукты на борщ в покупки",
    done: (facts) => facts.used.has("shopping") || facts.used.has("grocery"),
  },
];

/** Знакомство длится десять дней: касания в 1, 3 и 7 день, потом обычные «фишки». */
export const QUEST_DAYS = 10;
export const QUEST_TOUCH_DAYS: readonly number[] = [1, 3, 7];

export const QUEST_TEXT = {
  final: "Вы попробовали всё ✓ Дальше я рядом, когда нужно",
  labels: { later: "Позже", off: "Хватит подсказок", try: "Попробовать" },
  later: "Хорошо, вернёмся к этому позже.",
  /** Кнопка-ссылка под «Попробовать» семейного чата; та же, что в приветствии. */
  familyChatButton: "Подключить семейный чат",
  tried: "Подсказка ниже.",
  answered: "Подсказку я уже прислала.",
  unknown: "Эта подсказка устарела.",
} as const;

export function questStepByNumber(number: number | null): QuestStep | null {
  return QUEST_STEPS.find((step) => step.number === number) ?? null;
}

/**
 * Шаги этого человека на этом сервере. Участник пришёл в готовую семью: приглашение и чат делает владелец, а общее
 * дело в чате ему предлагается, только когда чат уже есть.
 */
export function availableQuestSteps(availability: QuestAvailability, person: { familyGroup: boolean; owner: boolean }): QuestStep[] {
  return QUEST_STEPS.filter((step) => (step.requires === null || availability[step.requires])
    && (person.owner || (!step.ownerOnly && (step.id !== "group_task" || person.familyGroup))));
}

/** Шаги, сделанные по фактам или уже отмеченные: отметка держит шаг, когда исходные строки истекли. */
export function doneQuestSteps(steps: readonly QuestStep[], facts: QuestFacts, marks: ReadonlySet<string>): QuestStep[] {
  return steps.filter((step) => marks.has(step.id) || step.done(facts));
}

/** Первый по порядку непройденный шаг, или null: всё сделано. */
export function nextQuestStep(steps: readonly QuestStep[], done: readonly QuestStep[]): QuestStep | null {
  const ids = new Set(done.map((step) => step.id));
  return steps.find((step) => !ids.has(step.id)) ?? null;
}

export function successCaption(done: number, total: number, next: QuestStep): string {
  return `Получилось ✓ ${done} из ${total}. Дальше — ${next.title}`;
}

export function touchCaption(done: number, total: number, next: QuestStep): string {
  return done === 0
    ? `Давайте знакомиться? Первый шаг — ${next.title}`
    : `Знакомство: ${done} из ${total} ✓ Следующий шаг — ${next.title}`;
}

export function questCardFile(step: QuestStep): string {
  return `img/onboarding/quest-${step.number}.jpg`;
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

/**
 * Какое касание пора прислать: самый поздний наступивший день из 1, 3, 7, если его касания ещё не было. Пропущенное
 * (тихие часы, пауза после молчания) не копится: на третий день приходит касание третьего дня, а не два сразу.
 * Даты местные, `YYYY-MM-DD`.
 */
export function dueQuestTouch(input: { joinedOn: string; marks: ReadonlySet<string>; today: string }): number | null {
  const days = dayNumber(input.today) - dayNumber(input.joinedOn);
  if (days >= QUEST_DAYS) return null;
  const due = [...QUEST_TOUCH_DAYS].reverse().find((day) => day <= days) ?? null;
  return due === null || input.marks.has(`touch_${due}`) ? null : due;
}
