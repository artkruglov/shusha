/**
 * Вкладка «Семья» Mini App: подход семьи живыми данными — области заботы, личное время, традиции, решения вдвоём, идеи.
 *
 * Exports:
 * - `WebAppFamily`: то, что получает страница.
 * - `webAppFamily`: чтение сводки и действия через те же репозитории, что инструменты чата
 *   (`careAreaRepository`, `personalTimeRepository`, `jointDecisionRepository`, `sharedTaskRepository`).
 *
 * Права лички, как в чате. Решения вдвоём читаются без области в правах: так личка отвечает на предложение после
 * уведомления (`decision-audience.ts`). Чужое личное время показывается только занятостью — день и часы без названия
 * (B02). Ничего не считается и не сравнивается: ни вклад, ни «кто больше» (подход, `family-balance-and-growth.ru.md`).
 */
import { careAreaRepository } from "../care-areas/care-area-repository.js";
import { database } from "../database.js";
import { familyChatLink } from "../groups-availability.js";
import { jointDecisionRepository } from "../joint-decisions/joint-decision-repository.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { personalTimeRepository } from "../personal-time/personal-time-repository.js";
import { sharedTaskRepository } from "../shared-task-repository.js";
import { longDay } from "./web-app-task-card.js";

export interface WebAppFamily {
  readonly areas: ReadonlyArray<{ id: string; version: number; title: string; details: string | null; owner: string | null;
    pendingOwner: string | null; status: string; mine: boolean; offeredToMe: boolean }>;
  readonly time: {
    readonly mine: ReadonlyArray<{ id: string; title: string; weekday: number | null; startsAt: string; endsAt: string }>;
    readonly others: ReadonlyArray<{ name: string; weekday: number | null; startsAt: string; endsAt: string }>;
  };
  /**
   * `onlyMine`: written in a private chat before traditions became the family's by default, so only the author sees it.
   * `doneToday` and `doneTodayByMe` are the viewer's own mark of today (`doneToday` keeps its name for older pages);
   * `doneTodayBy` names everyone in the family who marked it today, by first name. `last` is anyone's last mark.
   */
  readonly traditions: ReadonlyArray<{ id: string; version: number; title: string; last: string | null; doneToday: boolean;
    doneTodayByMe: boolean; doneTodayBy: readonly string[]; mine: boolean; onlyMine: boolean }>;
  readonly decisions: ReadonlyArray<{ id: string; version: number; title: string; status: string; isProposer: boolean;
    answered: boolean; answers: ReadonlyArray<{ name: string; choice: string; isYou: boolean }> }>;
  readonly ideas: ReadonlyArray<{ id: string; version: number; title: string; mine: boolean; onlyMine: boolean }>;
  /** `child`: a child in some area of the family; not offered an area to lead (review of 21 October 2026). */
  readonly participants: ReadonlyArray<{ ref: string; name: string; me: boolean; child: boolean }>;
  /**
   * «Где общаемся»: the family's own group chats by title, and for the owner the link that adds the bot to a group
   * (an existing one or a new one Telegram creates in the same flow) and connects it (`/start@бот family`).
   */
  readonly chats: { readonly groups: ReadonlyArray<{ title: string }>; readonly connectLink: string | null };
}

/** The private chat that answers a proposal after its notice has no area of its own (`decision-audience.ts`). */
const noArea = (auth: MemoryAuthorization): MemoryAuthorization => ({ ...auth, space: undefined });

/** «Юля Иванова» → «Юля»: the tab names people as the family calls them. */
function firstName(name: string): string {
  return name.trim().split(/\s+/u)[0] || name;
}

type TaskSummary = { id: string; version: number; title: string; kind: string; status: string; assignee: string | null; curator: string | null };

export const webAppFamily = {
  async read(auth: MemoryAuthorization, today: string): Promise<WebAppFamily> {
    const me = auth.telegramUserId!;
    const areas = (await careAreaRepository.execute(auth, { action: "list" })) as unknown as {
      areas: Array<{ id: string; version: number; title: string; details: string | null; owner: string | null; pendingOwner: string | null; status: string }>;
    };
    const owners = await database().query<{ id: string; owner_telegram_id: string | null; pending_owner_telegram_id: string | null }>(
      "SELECT id, owner_telegram_id, pending_owner_telegram_id FROM care_areas WHERE family_id = $1 AND id = ANY($2::uuid[])",
      [auth.familyId, areas.areas.map((area) => area.id)]);
    const ownerOf = new Map(owners.rows.map((row) => [row.id, row]));

    const mine = await personalTimeRepository.list(auth);
    const others = await database().query<{ name: string; weekday: number | null; starts_at: string; ends_at: string }>(
      `SELECT person.display_name AS name, slot.weekday, to_char(slot.starts_at, 'HH24:MI') AS starts_at,
              to_char(slot.ends_at, 'HH24:MI') AS ends_at
         FROM personal_time_windows slot JOIN users person ON person.id = slot.user_id
         JOIN family_memberships membership ON membership.user_id = person.id AND membership.family_id = slot.family_id
        WHERE slot.family_id = $1 AND slot.user_id <> $2
        ORDER BY person.display_name, slot.weekday NULLS FIRST, slot.starts_at`,
      [auth.familyId, auth.userId]);

    const list = async (view: string) => ((await sharedTaskRepository.execute(auth, { action: "list", view } as never, "webapp-read")) as {
      tasks?: TaskSummary[];
    }).tasks ?? [];
    const rituals = await list("rituals");
    const occurrences = await database().query<{ task_id: string; last: string }>(
      `SELECT task_id, max(occurred_on)::text AS last FROM shared_ritual_occurrences WHERE task_id = ANY($1::uuid[]) GROUP BY task_id`,
      [rituals.map((task) => task.id)]);
    const lastOf = new Map(occurrences.rows.map((row) => [row.task_id, row.last]));
    // Who marked each tradition today: only members of this family, by the first word of their name.
    const marks = await database().query<{ task_id: string; telegram_user_id: string; name: string }>(
      `SELECT DISTINCT mark.task_id, person.telegram_user_id, person.display_name AS name
         FROM shared_ritual_occurrences mark
         JOIN users person ON person.telegram_user_id = mark.actor_telegram_id
         JOIN family_memberships membership ON membership.user_id = person.id AND membership.family_id = $2
        WHERE mark.task_id = ANY($1::uuid[]) AND mark.occurred_on = $3::date
        ORDER BY name`,
      [rituals.map((task) => task.id), auth.familyId, today]);
    const markedToday = (id: string) => marks.rows.filter((row) => row.task_id === id);
    const ideas = await list("ideas");
    const creators = await database().query<{ id: string; creator_telegram_id: string; scope: string }>(
      "SELECT id, creator_telegram_id, scope FROM shared_tasks WHERE family_id = $1 AND id = ANY($2::uuid[])",
      [auth.familyId, [...ideas, ...rituals].map((task) => task.id)]);
    const creatorOf = new Map(creators.rows.map((row) => [row.id, row.creator_telegram_id]));
    const personal = new Set(creators.rows.filter((row) => row.scope === "personal").map((row) => row.id));

    const decisions = ((await jointDecisionRepository.execute(noArea(auth), { action: "list" }, "webapp-read")) as {
      decisions?: Array<{ id: string; version: number; title: string; status: string; isProposer: boolean;
        answers: Array<{ name: string; choice: string; isYou: boolean }> }>;
    }).decisions ?? [];
    const participants = ((await sharedTaskRepository.execute(auth, { action: "participants" } as never, "webapp-read")) as {
      participants?: Array<{ name: string; participantRef: string }>;
    }).participants ?? [];
    const refs = await database().query<{ id: string; telegram_user_id: string }>(
      "SELECT id, telegram_user_id FROM shared_task_participants WHERE family_id = $1 AND id = ANY($2::uuid[])",
      [auth.familyId, participants.map((person) => person.participantRef)]);
    const personOf = new Map(refs.rows.map((row) => [row.id, row.telegram_user_id]));
    const children = new Set((await database().query<{ telegram_user_id: string }>(
      `SELECT DISTINCT person.telegram_user_id FROM space_memberships membership JOIN users person ON person.id = membership.user_id
        WHERE membership.family_id = $1 AND membership.state = 'active' AND membership.role = 'child'`,
      [auth.familyId])).rows.map((row) => row.telegram_user_id));

    const groups = await database().query<{ title: string }>(
      `SELECT title FROM telegram_groups WHERE family_id = $1 AND type = 'family_private' ORDER BY created_at`,
      [auth.familyId]);
    const bot = process.env.TELEGRAM_BOT_USERNAME;

    return {
      chats: {
        connectLink: auth.role === "owner" ? familyChatLink(bot) : null,
        groups: groups.rows.map((row) => ({ title: row.title })),
      },
      areas: areas.areas.map((area) => ({
        ...area,
        mine: ownerOf.get(area.id)?.owner_telegram_id === me,
        offeredToMe: ownerOf.get(area.id)?.pending_owner_telegram_id === me,
      })),
      decisions: decisions.map((decision) => ({
        answered: decision.answers.some((answer) => answer.isYou), answers: decision.answers, id: decision.id,
        isProposer: decision.isProposer, status: decision.status, title: decision.title, version: decision.version,
      })),
      ideas: ideas.filter((task) => task.status !== "cancelled")
        .map((task) => ({ id: task.id, mine: creatorOf.get(task.id) === me, onlyMine: personal.has(task.id), title: task.title, version: task.version })),
      participants: participants.map((person) => ({
        child: children.has(personOf.get(person.participantRef) ?? ""), me: personOf.get(person.participantRef) === me,
        name: person.name, ref: person.participantRef,
      }))
        .sort((left, right) => Number(right.me) - Number(left.me) || left.name.localeCompare(right.name, "ru")),
      time: {
        mine: mine.map((window) => ({ endsAt: window.endsAt, id: window.id, startsAt: window.startsAt, title: window.title, weekday: window.weekday })),
        others: others.rows.map((row) => ({ endsAt: row.ends_at, name: row.name, startsAt: row.starts_at, weekday: row.weekday })),
      },
      traditions: rituals.map((task) => {
        const last = lastOf.get(task.id) ?? null;
        const byMe = markedToday(task.id).some((row) => row.telegram_user_id === me);
        return {
          doneToday: byMe, doneTodayBy: markedToday(task.id).map((row) => firstName(row.name)), doneTodayByMe: byMe,
          id: task.id, last: last === null ? null : longDay(last), mine: creatorOf.get(task.id) === me,
          onlyMine: personal.has(task.id), title: task.title, version: task.version,
        };
      }),
    };
  },

  /** «Было сегодня»: one mark a day per person (`shared_ritual_occurrences`), as «отметь традицию» in the chat. */
  async markTradition(auth: MemoryAuthorization, id: string, today: string, operationKey: string): Promise<void> {
    await sharedTaskRepository.execute(auth, { action: "record", id, note: "Отмечено в приложении", occurredOn: today } as never, operationKey);
  },

  async area(auth: MemoryAuthorization, input: { action: "accept" | "claim" | "decline" | "propose" | "release"; id: string;
    ownerRef?: string; version: number }): Promise<void> {
    await careAreaRepository.execute(auth, input);
  },

  async answer(auth: MemoryAuthorization, input: { choice: "agree" | "decline"; id: string; version: number }, operationKey: string): Promise<void> {
    await jointDecisionRepository.execute(noArea(auth), { action: "answer", ...input }, operationKey);
  },

  /**
   * The same window again is the same request: «Повторить» after a lost answer must not add a second one. The table's
   * unique key does not catch an every-day window (`weekday` NULL), so the check is made here first.
   */
  async addTime(auth: MemoryAuthorization, input: { endsAt: string; startsAt: string; title: string; weekday: number | null }): Promise<void> {
    const existing = await database().query(
      `SELECT 1 FROM personal_time_windows WHERE user_id = $1 AND weekday IS NOT DISTINCT FROM $2::smallint
          AND starts_at = $3::time AND ends_at = $4::time`,
      [auth.userId, input.weekday, input.startsAt, input.endsAt]);
    if ((existing.rowCount ?? 0) > 0) return;
    await personalTimeRepository.add(auth, input);
  },

  async removeTime(auth: MemoryAuthorization, id: string): Promise<void> {
    await personalTimeRepository.remove(auth, id);
  },
};
