/**
 * Telegram transport tests for owner-private memory-review failure alerts.
 *
 * Constructs covered:
 * - `createMemoryReviewOwnerAlertTransport`: bounded direct send with no implicit retry.
 * - HTTP rejection is definite while transport uncertainty is classified by the dispatcher.
 * - A chat Telegram calls gone is rejected with the stable unreachable code, and a chat already
 *   marked unreachable is skipped without a request; the skip stays a definite failure.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createMemoryReviewOwnerAlertTransport,
  MemoryReviewOwnerAlertTransportError,
  TelegramRecipientUnreachableError,
} from "./memory-review-owner-alert-transport.js";

describe("memory review owner alert transport", () => {
  it("sends plain text to the exact private owner chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, result: { message_id: 42 } }),
      { status: 200 },
    ));
    const transport = createMemoryReviewOwnerAlertTransport({
      botToken: "telegram-bot-secret",
      fetch: fetchMock,
      timeoutMilliseconds: 15_000,
    });

    await expect(transport.deliver({ chatId: "101", text: "Проверка памяти остановлена" }))
      .resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-bot-secret/sendMessage",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      chat_id: "101",
      text: "Проверка памяти остановлена",
    });
  });

  it("classifies an HTTP rejection as a definite delivery failure", async () => {
    const transport = createMemoryReviewOwnerAlertTransport({
      botToken: "telegram-bot-secret",
      fetch: vi.fn().mockResolvedValue(new Response("{}", { status: 403 })),
      timeoutMilliseconds: 15_000,
    });

    await expect(transport.deliver({ chatId: "101", text: "Проверка памяти остановлена" }))
      .rejects.toMatchObject({
        code: "AGENT_MEMORY_REVIEW_OWNER_ALERT_TELEGRAM_REJECTED",
        delivery: "failed",
      } satisfies Partial<MemoryReviewOwnerAlertTransportError>);
  });

  it("returns the confirmed message id so a started conversation lands in the journal", async () => {
    const reply = (body: unknown) => createMemoryReviewOwnerAlertTransport({
      botToken: "telegram-bot-secret",
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
      timeoutMilliseconds: 15_000,
    });

    await expect(reply({ ok: true, result: { message_id: 42 } }).send({ chatId: "101", text: "Привет" }))
      .resolves.toBe("42");
    await expect(reply({ ok: true, result: {} }).send({ chatId: "101", text: "Привет" }))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_MESSAGE_ID_MISSING" });
  });

  it("names a blocked bot with the stable unreachable code and its reason", async () => {
    const transport = createMemoryReviewOwnerAlertTransport({
      botToken: "telegram-bot-secret",
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        description: "Forbidden: bot was blocked by the user", error_code: 403, ok: false,
      }), { status: 403 })),
      timeoutMilliseconds: 15_000,
    });

    const failure = await transport.send({ chatId: "101", text: "Утренний обзор" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TelegramRecipientUnreachableError);
    expect(failure).toBeInstanceOf(MemoryReviewOwnerAlertTransportError);
    expect(failure).toMatchObject({
      chatId: "101", code: "AGENT_TELEGRAM_RECIPIENT_UNREACHABLE", delivery: "failed", reason: "blocked",
    });
  });

  it("skips a chat already marked unreachable without calling Telegram", async () => {
    const fetchMock = vi.fn();
    const transport = createMemoryReviewOwnerAlertTransport({
      botToken: "telegram-bot-secret",
      fetch: fetchMock,
      timeoutMilliseconds: 15_000,
      unreachableRecipient: vi.fn().mockResolvedValue("kicked"),
    });

    await expect(transport.deliver({ chatId: "-1001", text: "Сводка" }))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_RECIPIENT_UNREACHABLE", delivery: "failed", reason: "kicked" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses definitely when the reachability lookup fails, because nothing was sent", async () => {
    const fetchMock = vi.fn();
    const transport = createMemoryReviewOwnerAlertTransport({
      botToken: "telegram-bot-secret",
      fetch: fetchMock,
      timeoutMilliseconds: 15_000,
      unreachableRecipient: vi.fn().mockRejectedValue(new Error("connection terminated")),
    });

    await expect(transport.send({ chatId: "101", text: "Сводка" }))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_REACHABILITY_UNAVAILABLE", delivery: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
