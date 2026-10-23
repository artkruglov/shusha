/**
 * Карточка дела Mini App: история словами без рода, просрочка в днях по поясу человека и кнопки по правилам
 * статусов дела.
 */
import { describe, expect, it } from "vitest";

import { historyEntries, longDay, webAppTaskCard, type PresentedTask, type TaskCardFacts } from "./web-app-task-card.js";

const NOW = new Date("2026-10-16T09:00:00Z");
const TASK: PresentedTask = {
  details: null, dueAt: null, dueOn: "2026-10-14", id: "task-1", kind: "task", listName: "Переезд",
  repeat: null, scope: "family", status: "accepted", title: "Заказать матрас", version: 3,
};
const FACTS: TaskCardFacts = {
  assigneeTelegramId: "101", createdAt: new Date("2026-10-12T07:20:00Z"), creatorTelegramId: "101",
  inPlace: false, names: new Map([["101", "Артём"], ["102", "Юля"]]), pendingAssigneeTelegramId: null, pickedUpByOthers: false, space: "Пара",
  viewerTelegramId: "101",
};
const OPTIONS = { canMove: true, now: NOW, timezone: "Europe/Moscow" };

describe("Mini App task card", () => {
  it("tells the history in words, with what moved and no gendered verb", () => {
    const entries = historyEntries([
      { action: "update", actorTelegramId: "101", at: new Date("2026-10-14T16:15:00Z"), before: { due_on: "2026-10-13", title: "Заказать матрас" } },
      { action: "claim", actorTelegramId: "102", at: new Date("2026-10-15T08:00:00Z"), before: { due_on: "2026-10-14", title: "Заказать матрас" } },
    ], TASK, FACTS, "Europe/Moscow");
    expect(entries).toEqual([
      { at: "12 октября · 10:20", text: "Артём · создано" },
      { at: "14 октября · 19:15", text: "Артём · перенос: 13 октября → 14 октября" },
      { at: "15 октября · 11:00", text: "Юля · взято" },
    ]);
    expect(longDay("2026-01-05")).toBe("5 января");
  });

  it("counts overdue days in the person's day and names the area", () => {
    const card = webAppTaskCard(TASK, FACTS, [], OPTIONS);
    expect(card).toMatchObject({ assignee: "Артём", overdueDays: 2, project: "Переезд", visibility: "Пара" });
    expect(webAppTaskCard({ ...TASK, scope: "personal" }, FACTS, [], OPTIONS).visibility).toBe("Только мне");
    expect(webAppTaskCard({ ...TASK, status: "completed" }, FACTS, [], OPTIONS).overdueDays).toBe(0);
  });

  it("hands one's own task over and says who it waits for", () => {
    // Offered to Юля: she answers it; I may take the offer back and still close it, since it is mine until she agrees.
    const offered = { ...FACTS, pendingAssigneeTelegramId: "102" };
    expect(webAppTaskCard(TASK, { ...offered, viewerTelegramId: "102" }, [], OPTIONS))
      .toMatchObject({ actions: ["accept_transfer", "decline_transfer"], waiting: "Артём передаёт вам это дело" });
    const mine = webAppTaskCard(TASK, offered, [], OPTIONS);
    expect(mine.actions).toEqual(["complete", "decline_transfer", "postpone", "cancel", "unshare"]);
    expect(mine.waiting).toBe("Передаётся: Юля, ждёт ответа");
    // A request: the asker sees whom it waits for, the asked one sees who asks.
    expect(webAppTaskCard({ ...TASK, status: "proposed" }, { ...FACTS, assigneeTelegramId: "102" }, [], OPTIONS).waiting).toBe("Ждёт ответа: Юля");
    expect(webAppTaskCard({ ...TASK, status: "proposed" }, { ...FACTS, creatorTelegramId: "102" }, [], OPTIONS).waiting).toBe("Просит: Юля");
    expect(webAppTaskCard(TASK, FACTS, [], OPTIONS).waiting).toBeNull();
  });

  it("offers only the buttons the task's rules allow", () => {
    expect(webAppTaskCard(TASK, FACTS, [], OPTIONS).actions).toEqual(["complete", "transfer", "release", "postpone", "cancel", "unshare"]);
    expect(webAppTaskCard({ ...TASK, scope: "personal" }, FACTS, [], OPTIONS).actions).toEqual(["complete", "postpone", "cancel", "share"]);
    // A timed or repeating task keeps its date; a child does not edit.
    expect(webAppTaskCard({ ...TASK, dueAt: "2026-10-16T15:00:00Z" }, FACTS, [], OPTIONS).actions)
      .toEqual(["complete", "transfer", "release", "cancel", "unshare"]);
    expect(webAppTaskCard(TASK, FACTS, [], { ...OPTIONS, canMove: false }).actions).toEqual(["complete", "transfer", "release", "cancel", "unshare"]);
    // Asked of me: answer first. Asked by me of Юля: only take it back.
    const asked = { ...FACTS, assigneeTelegramId: "101", creatorTelegramId: "102" };
    expect(webAppTaskCard({ ...TASK, status: "proposed" }, asked, [], OPTIONS).actions).toEqual(["accept", "decline"]);
    const mine = { ...FACTS, assigneeTelegramId: "102" };
    expect(webAppTaskCard({ ...TASK, status: "proposed" }, mine, [], OPTIONS).actions).toEqual(["cancel"]);
    // Unowned: anyone takes it, only the author removes it.
    expect(webAppTaskCard({ ...TASK, status: "open" }, { ...FACTS, assigneeTelegramId: null, creatorTelegramId: "102" }, [], OPTIONS).actions)
      .toEqual(["claim", "complete"]);
    // Closed: back by the one who kept or wrote it, never a repeating one; an idea has no buttons.
    expect(webAppTaskCard({ ...TASK, status: "completed" }, FACTS, [], OPTIONS).actions).toEqual(["reopen"]);
    expect(webAppTaskCard({ ...TASK, repeat: { interval: 1, unit: "weekly" }, status: "completed" }, FACTS, [], OPTIONS).actions).toEqual([]);
    // An idea in an area: no «who sees it» here, only «Снять» by its author.
    expect(webAppTaskCard({ ...TASK, kind: "idea" }, FACTS, [], OPTIONS).actions).toEqual(["cancel"]);
  });

  it("lets the author of an idea or a tradition without an area change who sees it, until another person picked it up", () => {
    const spaceless = { ...FACTS, inPlace: true, space: null };
    const idea = { ...TASK, dueOn: null, kind: "idea", listName: null };
    expect(webAppTaskCard({ ...idea, scope: "personal" }, spaceless, [], OPTIONS).actions).toEqual(["share", "cancel"]);
    expect(webAppTaskCard(idea, spaceless, [], OPTIONS).actions).toEqual(["unshare", "cancel"]);
    expect(webAppTaskCard({ ...idea, kind: "ritual" }, spaceless, [], OPTIONS).actions).toEqual(["unshare", "cancel"]);
    expect(webAppTaskCard(idea, { ...spaceless, pickedUpByOthers: true }, [], OPTIONS).actions).toEqual(["cancel"]);
    // Its author may remove it even while another person keeps it; anyone else has nothing to change here.
    expect(webAppTaskCard(idea, { ...spaceless, creatorTelegramId: "102", viewerTelegramId: "102", assigneeTelegramId: "101" }, [], OPTIONS).actions)
      .toEqual(["cancel"]);
    expect(webAppTaskCard(idea, { ...spaceless, viewerTelegramId: "102" }, [], OPTIONS).actions).toEqual([]);
    expect(webAppTaskCard({ ...idea, status: "cancelled" }, spaceless, [], OPTIONS).actions).toEqual([]);
  });
});
