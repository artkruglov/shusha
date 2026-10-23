/**
 * Саморегистрация семей на реальной PostgreSQL.
 *
 * Constructs covered:
 * - вход по умолчанию закрыт; слово ссылки и потолок числа семей;
 * - человек, уже состоящий в семье, второй не получает; ждущий приглашения (строка `users` без семьи) получает свою;
 * - два одновременных Start при одном свободном месте дают одну семью;
 * - оператор это владелец самой ранней семьи.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { signupRepository } from "./signup-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("Unsafe test database");
const suite = enabled ? describe : describe.skip;
const profile = (id: string) => ({ displayName: `Человек ${id}`, telegramUserId: id });
const families = async () => Number((await database().query("SELECT count(*) AS n FROM families")).rows[0].n);

suite("self-serve signup", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families, users, signup_waitlist CASCADE");
    await database().query("UPDATE signup_settings SET is_open = false, word = NULL, max_families = 0");
  });
  afterAll(closeDatabase);

  it("is closed by default and creates nothing", async () => {
    expect(await signupRepository.claimSelfServeFamily(null, profile("1"))).toBe("closed");
    expect(await families()).toBe(0);
  });

  it("opens with a cap and no word, creates a family per person up to the cap", async () => {
    await signupRepository.update({ isOpen: true, maxFamilies: 2 });

    expect(await signupRepository.claimSelfServeFamily(null, profile("1"))).toBe("claimed");
    expect(await signupRepository.claimSelfServeFamily("anything", profile("2"))).toBe("claimed");
    expect(await signupRepository.claimSelfServeFamily(null, profile("3"))).toBe("full");
    expect(await families()).toBe(2);
    expect(await signupRepository.status()).toMatchObject({ families: 2, isOpen: true, maxFamilies: 2, word: null });
  });

  it("requires the link word when one is set, and refuses reserved word lengths", async () => {
    await signupRepository.update({ isOpen: true, maxFamilies: 5, word: "beta" });

    expect(await signupRepository.claimSelfServeFamily(null, profile("1"))).toBe("invalid");
    expect(await signupRepository.claimSelfServeFamily("alpha", profile("1"))).toBe("invalid");
    expect(await signupRepository.claimSelfServeFamily("beta", profile("1"))).toBe("claimed");
    await expect(signupRepository.update({ isOpen: true, word: "a".repeat(43) })).rejects.toThrow(/AGENT_SIGNUP_WORD_INVALID/);
    await expect(signupRepository.update({ isOpen: true, word: "a".repeat(32) })).rejects.toThrow(/AGENT_SIGNUP_WORD_INVALID/);
    await expect(signupRepository.update({ isOpen: true, word: "плохо" })).rejects.toThrow(/AGENT_SIGNUP_WORD_INVALID/);
  });

  it("does not give a second family to a member, but serves a person who only has a user row", async () => {
    await signupRepository.update({ isOpen: true, maxFamilies: 5 });
    await signupRepository.claimSelfServeFamily(null, profile("1"));
    await database().query("INSERT INTO users (telegram_user_id, display_name) VALUES ('2', 'Ждёт приглашения')");

    expect(await signupRepository.claimSelfServeFamily(null, profile("1"))).toBe("configured");
    expect(await signupRepository.claimSelfServeFamily(null, profile("2"))).toBe("claimed");
    expect(await families()).toBe(2);
  });

  it("lets two simultaneous starts take one free place only once", async () => {
    await signupRepository.update({ isOpen: true, maxFamilies: 1 });

    const results = await Promise.all([
      signupRepository.claimSelfServeFamily(null, profile("1")),
      signupRepository.claimSelfServeFamily(null, profile("2")),
    ]);

    expect(results.sort()).toEqual(["claimed", "full"]);
    expect(await families()).toBe(1);
  });

  it("names the owner of the earliest family the operator", async () => {
    await signupRepository.update({ isOpen: true, maxFamilies: 5 });
    await signupRepository.claimSelfServeFamily(null, profile("1"));
    await signupRepository.claimSelfServeFamily(null, profile("2"));
    const rows = (await database().query("SELECT id FROM families ORDER BY created_at, id")).rows;

    expect(await signupRepository.isOperatorFamily(rows[0].id)).toBe(true);
    expect(await signupRepository.isOperatorFamily(rows[1].id)).toBe(false);
  });

  it("queues people turned away while full and calls only as many as there are new places, once", async () => {
    await signupRepository.update({ isOpen: true, maxFamilies: 1 });
    expect(await signupRepository.claimSelfServeFamily(null, profile("1"))).toBe("claimed");
    for (const id of ["2", "3", "4"]) {
      expect(await signupRepository.claimSelfServeFamily(null, profile(id))).toBe("full");
      await signupRepository.joinWaitlist(profile(id));
    }
    await signupRepository.joinWaitlist(profile("2"));
    expect((await signupRepository.status()).waiting).toBe(3);
    // Мест нет: никого не зовём.
    expect((await signupRepository.takeWaitlistBatch()).ids).toEqual([]);
    // Набор расширили на два места: зовём первых двух по очереди, один раз.
    await signupRepository.update({ isOpen: true, maxFamilies: 3 });
    expect(await signupRepository.takeWaitlistBatch()).toEqual({ ids: ["2", "3"], word: null });
    expect((await signupRepository.takeWaitlistBatch()).ids).toEqual([]);
    expect((await signupRepository.status()).waiting).toBe(1);
    // Закрытый вход никого не зовёт.
    await signupRepository.update({ isOpen: false });
    expect((await signupRepository.takeWaitlistBatch()).ids).toEqual([]);
  });

  it("keeps a called person's place against strangers, lets them in, and returns a failed notice to the queue", async () => {
    await signupRepository.update({ isOpen: true, maxFamilies: 1, word: "beta" });
    expect(await signupRepository.claimSelfServeFamily("beta", profile("1"))).toBe("claimed");
    await signupRepository.joinWaitlist(profile("2"));
    await signupRepository.update({ isOpen: true, maxFamilies: 2 });
    // Место одно, оно за позванным: чужой его не занимает, слово ссылки возвращается вместе со списком.
    expect(await signupRepository.takeWaitlistBatch()).toEqual({ ids: ["2"], word: "beta" });
    expect(await signupRepository.claimSelfServeFamily("beta", profile("9"))).toBe("full");
    // Повторный /start при полном наборе не сбрасывает уведомление позванного и не даёт ему второй резерв.
    await signupRepository.joinWaitlist(profile("2"));
    expect((await database().query("SELECT notified_at FROM signup_waitlist WHERE telegram_user_id = '2'")).rows[0].notified_at).not.toBeNull();
    expect((await signupRepository.takeWaitlistBatch()).ids).toEqual([]);
    // Позванный входит по своему резерву.
    expect(await signupRepository.claimSelfServeFamily("beta", profile("2"))).toBe("claimed");

    // Сообщение не дошло: человек возвращается в очередь и освобождает резерв.
    await signupRepository.joinWaitlist(profile("3"));
    await signupRepository.update({ isOpen: true, maxFamilies: 3 });
    expect((await signupRepository.takeWaitlistBatch()).ids).toEqual(["3"]);
    await signupRepository.releaseWaitlistNotice("3");
    expect(await signupRepository.claimSelfServeFamily("beta", profile("8"))).toBe("claimed");
  });
});
