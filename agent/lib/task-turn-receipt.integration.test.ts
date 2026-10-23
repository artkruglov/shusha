/**
 * The receipt of what a turn closed comes from committed rows of this chat's session only.
 *
 * Constructs covered:
 * - A task completed through the repository in this session shows; one completed in another session
 *   (another chat) at the same time does not; one completed and then reopened does not.
 * - A cancelled task is listed apart; nothing changed means no receipt line.
 * - In a private chat the tasks this session wrote are listed with who sees them, and the default is asked once.
 * - An idea and a tradition written there are listed too: they get the who-sees button and the default question.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { sharedTaskRepository } from "./shared-task-repository.js";
import { appendTaskTurnReceipt, readTaskTurnReceipt } from "./task-turn-receipt.js";
import { createTwoFamilies, memoryAuth, TWO_FAMILIES_TRUNCATE, type TwoFamilies } from "./two-families-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);

(enabled ? describe : describe.skip)("task turn receipt", () => {
  let families: TwoFamilies;

  beforeEach(async () => {
    await database().query(TWO_FAMILIES_TRUNCATE);
    families = await createTwoFamilies();
  });
  afterAll(closeDatabase);

  it("lists only what this session closed and is still closed", async () => {
    const { a } = families;
    const auth = memoryAuth(a, a.owner, "private");
    let call = 0;
    const run = (session: string, input: Record<string, unknown>) =>
      sharedTaskRepository.execute(auth, input as never, `${session}:call-${++call}`);
    const create = async (title: string) => {
      const result = await run("eve-setup", { action: "create", title }) as { task?: { id: string; version: number } };
      return result.task!;
    };
    const video = await create("Подготовить видео");
    const insurance = await create("Подобрать страховку");
    const other = await create("Дело из другого чата");
    const reopened = await create("Закрыть и открыть");
    const dropped = await create("Отменить поход");
    const since = new Date(Date.now() - 1000);

    await run("eve-this", { action: "complete", id: video.id, version: video.version });
    await run("eve-this", { action: "complete", id: insurance.id, version: insurance.version });
    await run("eve-other", { action: "complete", id: other.id, version: other.version });
    const closed = await run("eve-this", { action: "complete", id: reopened.id, version: reopened.version }) as { task: { version: number } };
    await run("eve-this", { action: "reopen", id: reopened.id, version: closed.task.version });
    await run("eve-this", { action: "cancel", id: dropped.id, version: dropped.version });

    const receipt = await readTaskTurnReceipt({ eveSessionId: "eve-this", familyId: a.familyId, since, telegramUserId: a.owner.telegramUserId });
    expect(receipt).toMatchObject({ cancelled: ["Отменить поход"], completed: ["Подготовить видео", "Подобрать страховку"] });
    expect(receipt.undo.map((task) => task.title)).toEqual(["Отменить поход", "Подготовить видео", "Подобрать страховку"]);
    expect(receipt.undo.find((task) => task.id === video.id)?.version).toBeGreaterThan(video.version);
    expect(appendTaskTurnReceipt("Готово.", receipt))
      .toBe("Готово.\n\n✓ Закрыто: Подготовить видео; Подобрать страховку\n✗ Отменено: Отменить поход");

    const nothing = await readTaskTurnReceipt({ eveSessionId: "eve-none", familyId: a.familyId, since, telegramUserId: a.owner.telegramUserId });
    expect(appendTaskTurnReceipt("Ок.", nothing)).toBe("Ок.");
  });

  it("lists the tasks a private session wrote with who sees them, and asks the default until it is chosen", async () => {
    const { a } = families;
    const auth = memoryAuth(a, a.owner, "private");
    const since = new Date(Date.now() - 1000);
    await sharedTaskRepository.execute(auth, { action: "create", title: "Купить шины" } as never, "eve-this:call-1");
    await sharedTaskRepository.execute(auth, { action: "create", title: "Чужой чат" } as never, "eve-other:call-1");
    const receipt = await readTaskTurnReceipt({
      eveSessionId: "eve-this", familyId: a.familyId, privateChat: true, since, telegramUserId: a.owner.telegramUserId,
    });
    expect(receipt.created.map((task) => [task.title, task.scope, task.askedOther])).toEqual([["Купить шины", "personal", false]]);
    expect(receipt.askDefault).toBe(true);
    // The answer's own `filed` says who sees it: the receipt adds no line, only the buttons.
    expect(appendTaskTurnReceipt("Записала.", receipt)).toBe("Записала.");
    // In a group the receipt stays as it was.
    const group = await readTaskTurnReceipt({ eveSessionId: "eve-this", familyId: a.familyId, since, telegramUserId: a.owner.telegramUserId });
    expect(group).toMatchObject({ askDefault: false, created: [] });
  });

  it("lists an idea and a tradition the private session wrote, so they get the buttons and the question", async () => {
    const { a } = families;
    const auth = memoryAuth(a, a.owner, "private");
    const since = new Date(Date.now() - 1000);
    await sharedTaskRepository.execute(auth, { action: "create", kind: "idea", title: "Поход в горы" } as never, "eve-this:call-1");
    await sharedTaskRepository.execute(auth, { action: "create", kind: "ritual", title: "Блины в воскресенье" } as never, "eve-this:call-2");
    const receipt = await readTaskTurnReceipt({
      eveSessionId: "eve-this", familyId: a.familyId, privateChat: true, since, telegramUserId: a.owner.telegramUserId,
    });
    expect(receipt.created.map((task) => [task.title, task.scope, task.askedOther])).toEqual([
      ["Блины в воскресенье", "personal", false], ["Поход в горы", "personal", false],
    ]);
    expect(receipt.askDefault).toBe(true);
  });
});
