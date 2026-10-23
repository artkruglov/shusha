/**
 * Главный экран Mini App «Сегодня» (дизайн v9): к кому обращается Шуша, какое сейчас время суток у человека и что Шуша
 * недавно сделала.
 *
 * Exports:
 * - `WebAppHome`: то, что получает страница.
 * - `greetingOf`: «Доброе утро» / «Добрый день» / «Добрый вечер» / «Доброй ночи» по часу человека.
 * - `webAppHome`: имя, приветствие и последние картинки галереи.
 *
 * Дела страница берёт с доски (`/app-api/board`), здесь их не повторяем. «Шуша сделала за вас» — честный список того, что
 * действительно лежит в папке человека: последние сделанные картинки с подписью-запросом (`web-app-files.ts`).
 */
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { webAppFiles, type WebAppFile } from "./web-app-files.js";
import type { WebAppQuest } from "./web-app-quest.js";

const RECENT = 4;

export interface WebAppHome {
  readonly name: string;
  readonly greeting: string;
  readonly partOfDay: "evening" | "morning" | "day" | "night";
  readonly recent: readonly WebAppFile[];
  /** «Знакомство» for the hero ring; absent once the person is past it or hid it. */
  readonly quest?: WebAppQuest | null;
}

export function greetingOf(hour: number): { greeting: string; partOfDay: WebAppHome["partOfDay"] } {
  if (hour >= 5 && hour < 12) return { greeting: "Доброе утро", partOfDay: "morning" };
  if (hour >= 12 && hour < 18) return { greeting: "Добрый день", partOfDay: "day" };
  if (hour >= 18 && hour < 23) return { greeting: "Добрый вечер", partOfDay: "evening" };
  return { greeting: "Доброй ночи", partOfDay: "night" };
}

export const webAppHome = {
  async read(auth: MemoryAuthorization, timezone: string, now: Date): Promise<WebAppHome> {
    const { rows } = await database().query<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [auth.userId]);
    // The first word of the name the person gave Telegram: «Артём», not «Artem Kruglov» in full.
    const name = (rows[0]?.display_name ?? "").trim().split(/\s+/u)[0] ?? "";
    const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: timezone }).format(now)) % 24;
    const images = (await webAppFiles.list(auth)).filter((file) => file.kind === "image").slice(0, RECENT);
    return { ...greetingOf(hour), name, recent: images };
  },
};
