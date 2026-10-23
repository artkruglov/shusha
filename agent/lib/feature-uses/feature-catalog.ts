/**
 * Что человек уже попробовал: ключи возможностей и какие инструменты их выдают.
 *
 * Экспорт:
 * - `FEATURE_KEYS`, `FeatureKey`: ключи строк `feature_uses` (миграция 195) и признаков, посчитанных из данных.
 * - `featureOfTool`: возможность, которую показывает вызов инструмента, или null.
 *
 * Ключ это возможность глазами человека, а не имя инструмента: «напоминание» одно, сколько бы инструментов его ни
 * читали. Часть возможностей вызовом инструмента не видна (фото, голосовое, документ, просьба другому, гостевой
 * режим): их считает выборка совета из уже лежащих данных (`feature-use-repository.ts`), без новых записей.
 * `group_task` (первое «Беру» или «Сделано» кнопкой в семейной группе) пишет само нажатие
 * (`task-button-callback-production.ts`): кнопка живёт неделю, а шагу знакомства нужен след надолго.
 */
export const FEATURE_KEYS = [
  "chat", "web_search", "photo", "voice", "document", "image", "video", "reminder", "request", "guest", "grocery",
  "google", "shopping", "group_task",
] as const;

export type FeatureKey = typeof FEATURE_KEYS[number];

/**
 * Инструменты, вызов которых значит «человек это попробовал». `web_search` провайдера Eve называет в
 * `actions.requested` так же, как локальный инструмент (`describeTelegramStep` показывает по нему «🔎 Ищу»).
 */
const TOOL_FEATURES: Readonly<Record<string, FeatureKey>> = {
  execute_google_workspace: "google",
  generate_image: "image",
  generate_video: "video",
  grocery_cart: "grocery",
  inspect_workspace_image: "photo",
  manage_gmail_message: "google",
  manage_reminder: "reminder",
  manage_shopping_list: "shopping",
  web_fetch: "web_search",
  web_search: "web_search",
  web_search_2025_08_26: "web_search",
};

export function featureOfTool(toolName: string): FeatureKey | null {
  return Object.hasOwn(TOOL_FEATURES, toolName) ? TOOL_FEATURES[toolName]! : null;
}
