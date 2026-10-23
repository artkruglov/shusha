/**
 * Private-chat burst hold on a real PostgreSQL (ilkruglov 79f7adb, 29d1f82; nyxandro 0ee553f).
 *
 * Constructs covered:
 * - `claimNext` with a burst policy: a private head waits for the quiet window, a steady stream waits
 *   at most the cap, a group chat and a button press never wait.
 * - `heldPrivateChatReadyIn`: names the moment the held chat becomes claimable, and nothing for a
 *   chat whose head is already being worked on.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { NO_PRIVATE_BURST } from "./telegram-ingress-contract.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.slice(1).endsWith("_test")) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test");
}
const suite = enabled ? describe : describe.skip;
const LEASE_MS = 60_000;
const BURST = { maxWaitMilliseconds: 20_000, quietMilliseconds: 2_000 };

function message(updateId: number, chatType: "group" | "private", chatId: string) {
  return {
    continuationKey: `telegram:${chatType}:${chatId}`,
    payload: { message: { chat: { id: chatId, type: chatType }, message_id: updateId, text: "привет" }, update_id: updateId },
    updateId: String(updateId),
  };
}

async function age(updateId: number, milliseconds: number): Promise<void> {
  await database().query(
    "UPDATE telegram_ingress_updates SET received_at = now() - ($2 * interval '1 millisecond') WHERE update_id = $1",
    [updateId, milliseconds],
  );
}

suite("private chat burst", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE eve_session_event_cursors, telegram_ingress_ignored_updates,
         telegram_ingress_updates, telegram_ingress_continuation_aliases,
         telegram_ingress_queues CASCADE`,
    );
  });
  afterAll(closeDatabase);

  it("holds a fresh private head, then releases it once the chat has been quiet", async () => {
    await telegramIngressRepository.enqueue(message(9001, "private", "501"));
    expect(await telegramIngressRepository.claimNext(LEASE_MS, { burst: BURST })).toBeNull();
    const wait = await telegramIngressRepository.heldPrivateChatReadyIn?.(BURST);
    expect(wait).not.toBeNull();
    expect(wait!).toBeGreaterThan(0);
    expect(wait!).toBeLessThanOrEqual(BURST.quietMilliseconds);

    await age(9001, 3_000);
    expect((await telegramIngressRepository.claimNext(LEASE_MS, { burst: BURST }))?.updateId).toBe("9001");
  });

  it("keeps waiting while a newer message arrives, but never past the cap", async () => {
    await telegramIngressRepository.enqueue(message(9011, "private", "502"));
    await telegramIngressRepository.enqueue(message(9012, "private", "502"));
    // The head is old enough, but the newest message is fresh: the series is not complete yet.
    await age(9011, 10_000);
    expect(await telegramIngressRepository.claimNext(LEASE_MS, { burst: BURST })).toBeNull();
    // Past the cap a steady stream is claimed anyway.
    await age(9011, 25_000);
    expect((await telegramIngressRepository.claimNext(LEASE_MS, { burst: BURST }))?.updateId).toBe("9011");
  });

  it("never holds a group chat, a callback, or a call without a policy", async () => {
    await telegramIngressRepository.enqueue(message(9021, "group", "-100503"));
    expect((await telegramIngressRepository.claimNext(LEASE_MS, { burst: BURST }))?.updateId).toBe("9021");

    await telegramIngressRepository.enqueue(message(9031, "private", "504"));
    expect((await telegramIngressRepository.claimNext(LEASE_MS, { burst: NO_PRIVATE_BURST }))?.updateId).toBe("9031");
  });

  it("does not call a chat held while its head is already being worked on", async () => {
    await telegramIngressRepository.enqueue(message(9041, "private", "505"));
    await age(9041, 3_000);
    expect((await telegramIngressRepository.claimNext(LEASE_MS, { burst: BURST }))?.updateId).toBe("9041");
    await telegramIngressRepository.enqueue(message(9042, "private", "505"));
    expect(await telegramIngressRepository.heldPrivateChatReadyIn?.(BURST)).toBeNull();
  });

  it("does not hold a command", async () => {
    const command = message(9051, "private", "506");
    (command.payload.message as { text: string }).text = "/stop";
    await telegramIngressRepository.enqueue(command);
    expect((await telegramIngressRepository.claimNext(LEASE_MS, { burst: BURST }))?.updateId).toBe("9051");
  });

  it("rejects a malformed policy", async () => {
    await expect(telegramIngressRepository.claimNext(LEASE_MS, { burst: { maxWaitMilliseconds: 1, quietMilliseconds: 5 } }))
      .rejects.toThrow(/AGENT_TELEGRAM_BURST_WINDOW_INVALID/);
  });
});
