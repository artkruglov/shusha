/**
 * PostgreSQL durable Telegram ingress integration tests.
 *
 * Constructs covered:
 * - `telegramIngressRepository.enqueue`: idempotent update ingestion with conflict detection; a
 *   rich post stored or redelivered with its file cut out is the same update either way.
 * - `telegramIngressRepository.acceptMedia`: trust-zone decisions and tombstones are update-id atomic.
 * - Receipt/drain policy revocation: live external policy prevents a previously accepted download.
 * - `telegramIngressRepository.claimNext`: per-continuation FIFO with independent queue progress.
 * - Lease ownership: expired work can be reclaimed while stale workers are rejected.
 * - Continuation aliases: Telegram group re-keying keeps one logical FIFO.
 * - Voice transcript persistence: paid provider results survive delivery retries.
 * - `claimStalledIngress`: a message dispatched long ago and still processing is claimed for one alert.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";
import { claimStalledIngress } from "./telegram-ingress-stall.js";
import {
  BOT_USERNAME,
  groupMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";
import { telegramRepository } from "./telegram-repository.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;
const LEASE_MILLISECONDS = 60_000;

if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error(
      "AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL",
    );
  }
  if (!new URL(integrationDatabaseUrl).pathname.slice(1).endsWith("_test")) {
    throw new Error(
      "AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test",
    );
  }
}

const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

function updateInput(updateId: string, continuationKey: string, text: string) {
  return {
    continuationKey,
    payload: {
      message: {
        chat: { id: continuationKey, type: "private" },
        message_id: Number(updateId),
        text,
      },
      update_id: Number(updateId),
    },
    updateId,
  };
}

describeWithDatabase("telegramIngressRepository", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE eve_session_event_cursors, telegram_ingress_ignored_updates,
         telegram_ingress_updates, telegram_ingress_continuation_aliases,
         telegram_ingress_queues CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("deduplicates an identical update and rejects a conflicting replay", async () => {
    const update = updateInput("1001", "telegram:private:101", "первое сообщение");

    await expect(telegramIngressRepository.enqueue(update)).resolves.toBe("inserted");
    await expect(telegramIngressRepository.enqueue(update)).resolves.toBe("duplicate");
    await expect(
      telegramIngressRepository.enqueue({ ...update, payload: { ...update.payload, forged: true } }),
    ).rejects.toThrowError(/AGENT_TELEGRAM_UPDATE_CONFLICT/);

    const count = await database().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM telegram_ingress_updates",
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("leaves no tombstone for a refused photo whose post still has text, so the text is queued", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Ingress rich family') RETURNING id",
    );
    await database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES ($1, '-100-rich', 'Rich group', 'external', 'addressed_only', '{}')`,
      [family.rows[0]!.id],
    );
    const update = updateInput("1003", "telegram:group:-100-rich", "пост канала с фото");

    await expect(telegramIngressRepository.acceptMedia({
      chatId: "-100-rich", chatType: "supergroup", mediaKind: "native_photo", textFallback: true, updateId: update.updateId,
    })).resolves.toBe(false);
    await expect(telegramIngressRepository.enqueue(update)).resolves.toBe("inserted");
    const ignored = await database().query("SELECT 1 FROM telegram_ingress_ignored_updates WHERE update_id = $1", [update.updateId]);
    expect(ignored.rowCount).toBe(0);
  });

  it("treats a redelivered rich post with its file as the duplicate of its stored text-only shape", async () => {
    const blocks = [{ photo: [{ file_id: "p-redelivered", file_unique_id: "u" }], type: "photo" }, { text: "пост", type: "paragraph" }];
    const withFile = { ...updateInput("1004", "telegram:group:-100-rich-again", "пост"), payload: { message: { chat: { id: -100 }, rich_message: { blocks } }, update_id: 1004 } };
    const textOnly = { ...withFile, payload: { message: { chat: { id: -100 }, rich_message: { blocks: [{ text: "пост", type: "paragraph" }] } }, update_id: 1004 } };

    await expect(telegramIngressRepository.enqueue(textOnly)).resolves.toBe("inserted");
    await expect(telegramIngressRepository.enqueue(withFile)).resolves.toBe("duplicate");
    await expect(telegramIngressRepository.enqueue({ ...withFile, payload: { ...withFile.payload, update_id: 1005 } })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_UPDATE_CONFLICT" });
  });

  // The grant was removed between the first delivery (stored with its file) and Telegram's
  // redelivery, which the ingress now stores without the file: the same update, not a conflict.
  it("treats a stripped redelivery of a rich post stored with its file as the duplicate", async () => {
    const blocks = [{ photo: [{ file_id: "p-granted", file_unique_id: "u" }], type: "photo" }, { text: "пост", type: "paragraph" }];
    const withFile = { ...updateInput("1006", "telegram:group:-100-rich-revoked", "пост"), payload: { message: { chat: { id: -100 }, rich_message: { blocks } }, update_id: 1006 } };
    const textOnly = { ...withFile, payload: { message: { chat: { id: -100 }, rich_message: { blocks: [{ text: "пост", type: "paragraph" }] } }, update_id: 1006 } };
    const otherFile = { ...withFile, payload: { message: { chat: { id: -100 }, rich_message: { blocks: [{ photo: [{ file_id: "p-other" }], type: "photo" }, blocks[1]] } }, update_id: 1006 } };

    await expect(telegramIngressRepository.enqueue(withFile)).resolves.toBe("inserted");
    await expect(telegramIngressRepository.enqueue(textOnly)).resolves.toBe("duplicate");
    await expect(telegramIngressRepository.enqueue(otherFile)).rejects.toMatchObject({ code: "AGENT_TELEGRAM_UPDATE_CONFLICT" });
    const stored = await database().query<{ payload: unknown }>("SELECT payload FROM telegram_ingress_updates WHERE update_id = 1006");
    expect(JSON.stringify(stored.rows[0]?.payload)).toContain("p-granted");
  });

  // Migration 175: an external group may live without a family (family_id NULL).
  it("decides the media of a familyless external group by its own grant, with the text fallback", async () => {
    await database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist,
          enabled_by_telegram_user_id, monthly_budget_usd)
       VALUES (NULL, '-100-rich-familyless', 'Familyless rich', 'external', 'addressed_only', '{}', '424242', 5),
              (NULL, '-100-rich-familyless-granted', 'Familyless granted', 'external', 'addressed_only',
               '{inspect_workspace_image}', '424243', 5)`,
    );
    const media = (chatId: string, updateId: string, textFallback: boolean) => telegramIngressRepository.acceptMedia({
      chatId, chatType: "supergroup", mediaKind: "native_photo", textFallback, updateId,
    });
    const tombstoned = async (updateId: string) =>
      (await database().query("SELECT 1 FROM telegram_ingress_ignored_updates WHERE update_id = $1", [updateId])).rowCount;

    await expect(media("-100-rich-familyless", "1007", true)).resolves.toBe(false);
    expect(await tombstoned("1007")).toBe(0);
    await expect(telegramIngressRepository.enqueue(updateInput("1007", "telegram:group:-100-rich-familyless", "пост"))).resolves.toBe("inserted");
    await expect(media("-100-rich-familyless", "1008", false)).resolves.toBe(false);
    expect(await tombstoned("1008")).toBe(1);
    await expect(media("-100-rich-familyless-granted", "1009", true)).resolves.toBe(true);
    expect(await tombstoned("1009")).toBe(0);
  });

  it("keeps a rejected update tombstoned after the group becomes family-private", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Ingress policy family') RETURNING id",
    );
    await database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES ($1, '-100-policy', 'Policy group', 'external', 'addressed_only', '{}')`,
      [family.rows[0]!.id],
    );
    const update = updateInput("1002", "telegram:group:-100-policy", "повтор после смены зоны");

    await expect(telegramIngressRepository.acceptMedia({
      chatId: "-100-policy",
      chatType: "supergroup",
      mediaKind: "native_photo",
      updateId: update.updateId,
    })).resolves.toBe(false);
    await database().query(
      "UPDATE telegram_groups SET type = 'family_private' WHERE telegram_chat_id = '-100-policy'",
    );
    await expect(telegramIngressRepository.acceptMedia({
      chatId: "-100-policy",
      chatType: "supergroup",
      mediaKind: "native_photo",
      updateId: update.updateId,
    })).resolves.toBe(false);
    await expect(telegramIngressRepository.enqueue(update)).resolves.toBe("duplicate");

    const retained = await database().query<{ ignored: string; queued: string }>(
      `SELECT
         (SELECT count(*)::text FROM telegram_ingress_ignored_updates) AS ignored,
         (SELECT count(*)::text FROM telegram_ingress_updates) AS queued`,
    );
    expect(retained.rows[0]).toEqual({ ignored: "1", queued: "0" });
    await expect(telegramIngressRepository.claimNext(LEASE_MILLISECONDS)).resolves.toBeNull();
  });

  it("accepts allowlisted static-image candidates and tombstones unsupported external media", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('External photo family') RETURNING id",
    );
    await database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES ($1, '-100-photo', 'Photo group', 'external', 'addressed_only',
         ARRAY['inspect_workspace_image'])`,
      [family.rows[0]!.id],
    );

    await expect(telegramIngressRepository.acceptMedia({
      chatId: "-100-photo",
      chatType: "supergroup",
      mediaKind: "native_photo",
      updateId: "1010",
    })).resolves.toBe(true);
    await expect(telegramIngressRepository.acceptMedia({
      chatId: "-100-photo",
      chatType: "supergroup",
      mediaKind: "image_document_candidate",
      updateId: "1011",
    })).resolves.toBe(true);
    await expect(telegramIngressRepository.acceptMedia({
      chatId: "-100-photo",
      chatType: "supergroup",
      mediaKind: "unsupported_media",
      updateId: "1014",
    })).resolves.toBe(false);

    const ignored = await database().query<{ update_id: string }>(
      "SELECT update_id::text FROM telegram_ingress_ignored_updates ORDER BY update_id",
    );
    expect(ignored.rows).toEqual([{ update_id: "1014" }]);
  });

  it("accepts text-document candidates only for an external group with attachment import enabled", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('External text attachment family') RETURNING id",
    );
    await database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES
         ($1, '-100-text-enabled', 'Text enabled', 'external', 'addressed_only',
          ARRAY['import_telegram_attachment']),
         ($1, '-100-text-disabled', 'Text disabled', 'external', 'addressed_only', '{}')`,
      [family.rows[0]!.id],
    );

    await expect(telegramIngressRepository.acceptMedia({
      chatId: "-100-text-enabled",
      chatType: "supergroup",
      mediaKind: "text_document_candidate",
      updateId: "1015",
    })).resolves.toBe(true);
    await expect(telegramIngressRepository.acceptMedia({
      chatId: "-100-text-disabled",
      chatType: "supergroup",
      mediaKind: "text_document_candidate",
      updateId: "1016",
    })).resolves.toBe(false);
    await expect(database().query(
      "SELECT 1 FROM telegram_ingress_ignored_updates WHERE update_id = 1016",
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("tombstones a photo when any persisted external capability is malformed", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Malformed photo policy family') RETURNING id",
    );
    await database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES ($1, '-100-malformed-photo', 'Malformed photo policy', 'external',
         'addressed_only', ARRAY['inspect_workspace_image', 'unknown_tool'])`,
      [family.rows[0]!.id],
    );

    await expect(telegramIngressRepository.acceptMedia({
      chatId: "-100-malformed-photo",
      chatType: "supergroup",
      mediaKind: "native_photo",
      updateId: "1013",
    })).resolves.toBe(false);
    await expect(database().query(
      "SELECT 1 FROM telegram_ingress_ignored_updates WHERE update_id = 1013",
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("rechecks revoked external photo policy between receipt and drain", async () => {
    await database().query("DELETE FROM families WHERE name = 'Revoked photo family'");
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Revoked photo family') RETURNING id",
    );
    await database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES ($1, '-100-revoked-photo', 'Revoked photo group', 'external',
         'addressed_only', ARRAY['inspect_workspace_image'])`,
      [family.rows[0]!.id],
    );
    await expect(telegramIngressRepository.acceptMedia({
      chatId: "-100-revoked-photo",
      chatType: "supergroup",
      mediaKind: "native_photo",
      updateId: "1012",
    })).resolves.toBe(true);

    // Revocation after receipt must win at the live onMessage boundary before any remote download.
    await database().query(
      "UPDATE telegram_groups SET tool_allowlist = '{}' WHERE telegram_chat_id = '-100-revoked-photo'",
    );
    const repository = repositories();
    repository.telegram.findGroup.mockImplementation(telegramRepository.findGroup);
    const message: TelegramMessage = {
      ...groupMessage(`@${BOT_USERNAME} что изображено?`),
      attachments: [{ fileId: "photo-file", fileUniqueId: "photo-id", kind: "photo" }],
      chat: { id: "-100-revoked-photo", title: "Revoked photo group", type: "supergroup" },
      raw: {
        date: 1_700_000_000,
        photo: [{ file_id: "photo-file", height: 640, width: 640 }],
      },
    };

    await expect(
      createTelegramMessageHandler(repository)(telegramContext().context, message),
    ).resolves.toBeNull();
    expect(repository.journal.record).not.toHaveBeenCalled();
    expect(repository.attachments.persist).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it("claims only the oldest update per queue while another queue progresses", async () => {
    await telegramIngressRepository.enqueue(updateInput("2001", "telegram:private:101", "один"));
    await telegramIngressRepository.enqueue(updateInput("2002", "telegram:private:101", "два"));
    await telegramIngressRepository.enqueue(updateInput("2003", "telegram:private:202", "другая очередь"));

    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    const independent = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    const blocked = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);

    expect(first?.updateId).toBe("2001");
    expect(independent?.updateId).toBe("2003");
    expect(blocked).toBeNull();

    await telegramIngressRepository.completeWithSession(
      first!.updateId,
      first!.leaseToken,
      "eve-session-2001",
      4,
    );

    await expect(telegramIngressRepository.claimNext(LEASE_MILLISECONDS)).resolves.toMatchObject({
      updateId: "2002",
    });
  });

  it("claims only button presses for the callback pool and keeps them behind their chat head", async () => {
    const callback = (updateId: string, chatId: string) => ({
      continuationKey: `telegram:private:${chatId}`,
      payload: {
        callback_query: {
          chat_instance: "1",
          data: "eve:0",
          from: { first_name: "Анна", id: 101, is_bot: false },
          id: `callback-${updateId}`,
          message: { chat: { id: chatId, type: "private" }, date: 1, message_id: 9, text: "Подтвердите" },
        },
        update_id: Number(updateId),
      },
      updateId,
    });
    await telegramIngressRepository.enqueue(updateInput("2101", "telegram:private:101", "длинный ход"));
    await telegramIngressRepository.enqueue(callback("2102", "101"));
    await telegramIngressRepository.enqueue(updateInput("2103", "telegram:private:202", "сообщение"));
    await telegramIngressRepository.enqueue(callback("2104", "303"));

    // The press in chat 303 is claimable; the press in chat 101 waits behind that chat's message,
    // and no ordinary message is ever handed to the callback pool.
    await expect(telegramIngressRepository.claimNext(LEASE_MILLISECONDS, { callbackOnly: true }))
      .resolves.toMatchObject({ updateId: "2104" });
    await expect(telegramIngressRepository.claimNext(LEASE_MILLISECONDS, { callbackOnly: true }))
      .resolves.toBeNull();

    const head = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    expect(head?.updateId).toBe("2101");
    await telegramIngressRepository.complete(head!.updateId, head!.leaseToken);
    await expect(telegramIngressRepository.claimNext(LEASE_MILLISECONDS, { callbackOnly: true }))
      .resolves.toMatchObject({ updateId: "2102" });
  });

  it("hands a guest message to the callback pool", async () => {
    await telegramIngressRepository.enqueue(updateInput("2151", "telegram:private:101", "длинный ход"));
    await telegramIngressRepository.enqueue({
      continuationKey: "telegram:guest:q-1",
      payload: {
        guest_message: {
          chat: { id: 501, type: "private" },
          date: 1,
          from: { first_name: "Анна", id: 101, is_bot: false },
          guest_query_id: "q-1",
          message_id: 9,
          text: "@bot привет",
        },
        update_id: 2152,
      },
      updateId: "2152",
    });

    await expect(telegramIngressRepository.claimNext(LEASE_MILLISECONDS, { callbackOnly: true }))
      .resolves.toMatchObject({ updateId: "2152" });
  });

  it("lists the pending tail behind a claimed head without leasing it", async () => {
    await telegramIngressRepository.enqueue(updateInput("2201", "telegram:private:101", "раз"));
    await telegramIngressRepository.enqueue(updateInput("2202", "telegram:private:101", "два"));
    await telegramIngressRepository.enqueue(updateInput("2203", "telegram:private:101", "три"));
    const head = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);

    const tail = await telegramIngressRepository.listPendingAfter({
      afterUpdateId: head!.updateId, limit: 1, queueId: head!.queueId,
    });
    expect(tail.map((row) => (row.payload.message as { text: string }).text)).toEqual(["два"]);
    expect(tail[0]?.receivedAt).toBeInstanceOf(Date);
    await expect(telegramIngressRepository.listPendingAfter({
      afterUpdateId: head!.updateId, limit: 10, queueId: head!.queueId,
    })).resolves.toHaveLength(2);
    // Reading the tail leases nothing: the next claim still takes the second message.
    await telegramIngressRepository.complete(head!.updateId, head!.leaseToken);
    await expect(telegramIngressRepository.claimNext(LEASE_MILLISECONDS)).resolves.toMatchObject({ updateId: "2202" });
  });

  it("leases the accepted run behind a claimed head and leaves the rest pending", async () => {
    await telegramIngressRepository.enqueue(updateInput("2101", "telegram:private:101", "раз"));
    await telegramIngressRepository.enqueue(updateInput("2102", "telegram:private:101", "два"));
    await telegramIngressRepository.enqueue(updateInput("2103", "telegram:private:101", "три"));
    await telegramIngressRepository.enqueue(updateInput("2104", "telegram:private:101", "четыре"));
    const head = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    expect(head?.updateId).toBe("2101");

    const followers = await telegramIngressRepository.claimFollowing({
      accept: (payload) => (payload.message as { text: string }).text !== "четыре",
      afterUpdateId: head!.updateId,
      leaseMilliseconds: LEASE_MILLISECONDS,
      limit: 4,
      queueId: head!.queueId,
    });

    expect(followers.map((claim) => claim.updateId)).toEqual(["2102", "2103"]);
    expect(new Set(followers.map((claim) => claim.leaseToken)).size).toBe(2);
    // The refused item stays pending behind the leased run and becomes the next head later.
    await expect(telegramIngressRepository.claimNext(LEASE_MILLISECONDS)).resolves.toBeNull();
    for (const claim of [head!, ...followers]) {
      await telegramIngressRepository.complete(claim.updateId, claim.leaseToken);
    }
    await expect(telegramIngressRepository.claimNext(LEASE_MILLISECONDS)).resolves.toMatchObject({
      updateId: "2104",
    });
  });

  it("persists a monotonic Eve event cursor atomically with ingress completion", async () => {
    const continuationKey = "telegram:private:cursor";
    const sessionId = "eve-session-cursor";
    await telegramIngressRepository.enqueue(updateInput("2101", continuationKey, "первый turn"));
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    await telegramIngressRepository.completeWithSession(
      first!.updateId,
      first!.leaseToken,
      sessionId,
      4,
    );
    await expect(telegramIngressRepository.sessionEventStreamCursor(sessionId)).resolves.toBe(4);

    // A stale boundary cannot complete ingress unless its cursor update commits in the same transaction.
    await telegramIngressRepository.enqueue(updateInput("2102", continuationKey, "второй turn"));
    const second = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    await expect(telegramIngressRepository.completeWithSession(
      second!.updateId,
      second!.leaseToken,
      sessionId,
      3,
    )).rejects.toThrowError(/AGENT_TELEGRAM_SESSION_CURSOR_REGRESSION/u);
    await expect(database().query<{ status: string }>(
      "SELECT status FROM telegram_ingress_updates WHERE update_id = 2102",
    )).resolves.toMatchObject({ rows: [{ status: "processing" }] });
    await expect(telegramIngressRepository.sessionEventStreamCursor(sessionId)).resolves.toBe(4);

    await telegramIngressRepository.completeWithSession(
      second!.updateId,
      second!.leaseToken,
      sessionId,
      7,
    );
    await expect(telegramIngressRepository.sessionEventStreamCursor(sessionId)).resolves.toBe(7);
  });

  it("reclaims an expired lease and rejects the stale worker token", async () => {
    await telegramIngressRepository.enqueue(updateInput("3001", "telegram:private:101", "lease"));
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    expect(first).not.toBeNull();
    await database().query(
      "UPDATE telegram_ingress_updates SET lease_expires_at = now() - interval '1 second' WHERE update_id = $1",
      [first!.updateId],
    );

    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);

    expect(reclaimed?.updateId).toBe(first?.updateId);
    expect(reclaimed?.leaseToken).not.toBe(first?.leaseToken);
    await expect(
      telegramIngressRepository.completeWithSession(
        first!.updateId,
        first!.leaseToken,
        "stale-session",
        1,
      ),
    ).rejects.toThrowError(/AGENT_TELEGRAM_LEASE_LOST/);
  });

  // 2 October 2026: a dispatched private message stayed processing for 8.5 hours unnoticed.
  it("claims a long-dispatched message for one stall alert", async () => {
    await telegramIngressRepository.enqueue(updateInput("3051", "telegram:private:111", "ты тут?"));
    const claim = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    await telegramIngressRepository.beginDispatch(claim!.updateId, claim!.leaseToken);
    await expect(claimStalledIngress(30 * 60 * 1000)).resolves.toEqual([]);

    await database().query(
      "UPDATE telegram_ingress_updates SET dispatch_started_at = now() - interval '31 minutes' WHERE update_id = 3051",
    );
    await expect(claimStalledIngress(30 * 60 * 1000)).resolves.toMatchObject([{ chatType: "private", updateId: "3051" }]);
    // The claim is written with the alert, so the next tick does not repeat it.
    await expect(claimStalledIngress(30 * 60 * 1000)).resolves.toEqual([]);
  });

  it("releases every live processing lease so a restarted process can reclaim at once", async () => {
    await telegramIngressRepository.enqueue(updateInput("3101", "telegram:private:101", "restart"));
    await telegramIngressRepository.enqueue(updateInput("3102", "telegram:private:101", "queued behind"));
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    expect(first?.updateId).toBe("3101");
    await expect(telegramIngressRepository.claimNext(LEASE_MILLISECONDS)).resolves.toBeNull();

    await expect(telegramIngressRepository.releaseStaleLeases()).resolves.toBe(1);

    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    expect(reclaimed?.updateId).toBe("3101");
    expect(reclaimed?.attemptCount).toBe(2);
    expect(reclaimed?.leaseToken).not.toBe(first?.leaseToken);
    // The dead process's token must not be able to complete the reclaimed item.
    await expect(
      telegramIngressRepository.complete(first!.updateId, first!.leaseToken),
    ).rejects.toThrowError(/AGENT_TELEGRAM_LEASE_LOST/);
  });

  it("keeps new Telegram anchors in the same logical FIFO", async () => {
    await telegramIngressRepository.enqueue(updateInput("4001", "telegram:group:old", "первое"));
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    expect(first).not.toBeNull();

    await telegramIngressRepository.rekeyQueue({
      nextContinuationKey: "telegram:group:new",
      previousContinuationKey: "telegram:group:old",
      queueId: first!.queueId,
    });
    await telegramIngressRepository.enqueue(updateInput("4002", "telegram:group:new", "следующее"));
    await telegramIngressRepository.release(first!.updateId, first!.leaseToken, {
      code: "AGENT_TELEGRAM_DELIVERY_INTERRUPTED",
      message: "Передача сообщения в Eve была прервана. Обработка будет запущена повторно",
    });

    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    expect(reclaimed).toMatchObject({
      deliveryContinuationKey: "telegram:group:new",
      queueId: first!.queueId,
      updateId: "4001",
    });
  });

  it("persists one voice transcript across a released delivery attempt", async () => {
    await telegramIngressRepository.enqueue({
      ...updateInput("5001", "telegram:private:101", ""),
      voice: {
        fileId: "telegram-file-5001",
        fileSize: 512,
        mimeType: "audio/ogg",
      },
    });
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);

    await telegramIngressRepository.beginVoiceTranscription(first!.updateId, first!.leaseToken);
    await telegramIngressRepository.saveVoiceTranscript(
      first!.updateId,
      first!.leaseToken,
      "Купи молоко",
    );
    await telegramIngressRepository.release(first!.updateId, first!.leaseToken, {
      code: "AGENT_TELEGRAM_DELIVERY_INTERRUPTED",
      message: "Передача сообщения в Eve была прервана. Обработка будет запущена повторно",
    });
    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);

    expect(reclaimed).toMatchObject({
      transcript: "Купи молоко",
      updateId: "5001",
      voice: {
        fileId: "telegram-file-5001",
        fileSize: 512,
        mimeType: "audio/ogg",
      },
    });
    await expect(
      telegramIngressRepository.beginVoiceTranscription(
        reclaimed!.updateId,
        reclaimed!.leaseToken,
      ),
    ).resolves.toBe("completed");
    await expect(
      telegramIngressRepository.saveVoiceTranscript(
        reclaimed!.updateId,
        reclaimed!.leaseToken,
        "Другой результат",
      ),
    ).rejects.toThrowError(/AGENT_VOICE_TRANSCRIPT_CONFLICT/);
  });

  it("does not repeat a provider call after transcription started without a saved result", async () => {
    await telegramIngressRepository.enqueue({
      ...updateInput("5002", "telegram:private:101", ""),
      voice: { fileId: "telegram-file-5002" },
    });
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    await telegramIngressRepository.beginVoiceTranscription(first!.updateId, first!.leaseToken);
    await telegramIngressRepository.release(first!.updateId, first!.leaseToken, {
      code: "AGENT_PROCESS_INTERRUPTED",
      message: "Процесс был прерван",
    });
    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);

    await expect(
      telegramIngressRepository.beginVoiceTranscription(
        reclaimed!.updateId,
        reclaimed!.leaseToken,
      ),
    ).rejects.toThrowError(/AGENT_VOICE_TRANSCRIPTION_RECOVERY_REQUIRED/);
  });

  it("does not repeat an Eve dispatch after its durable start marker", async () => {
    await telegramIngressRepository.enqueue(updateInput("6001", "telegram:private:101", "действие"));
    const first = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);
    await telegramIngressRepository.beginDispatch(first!.updateId, first!.leaseToken);
    await telegramIngressRepository.release(first!.updateId, first!.leaseToken, {
      code: "AGENT_PROCESS_INTERRUPTED",
      message: "Процесс был прерван",
    });
    const reclaimed = await telegramIngressRepository.claimNext(LEASE_MILLISECONDS);

    await expect(
      telegramIngressRepository.beginDispatch(reclaimed!.updateId, reclaimed!.leaseToken),
    ).rejects.toThrowError(/AGENT_TELEGRAM_DISPATCH_RECOVERY_REQUIRED/);
  });
});
