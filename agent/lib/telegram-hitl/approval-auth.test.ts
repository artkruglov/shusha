/**
 * Auth возобновлённого хода после подтверждения в Telegram.
 *
 * Проверяется: контекст запросившего хода (сессия sandbox, позиция таймлайна, видимые записи,
 * начало хода) восстанавливается из строки подтверждения, а нить сессии служит запасной
 * sandbox-сессией; атрибуты политики берутся только из свежего чтения БД, сохранённая роль, область
 * или allowlist в возобновлённый auth не попадают; `retainTurnAttributes` оставляет ровно ключи
 * контекста.
 */
import { describe, expect, it, vi } from "vitest";

import { type ApprovalAuthRow, resolveCurrentApprovalAuth, retainTurnAttributes } from "./approval-auth.js";

const row: ApprovalAuthRow = {
  application_session_id: "app-1", eve_session_id: "wrun_1", expected_telegram_user_id: "104", family_id: "fam-1",
  group_id: null, owner_user_id: "user-1", scope: "personal", telegram_chat_id: "104", telegram_chat_type: "private",
  telegram_conversation_id: "conv-1", telegram_message_id: "55", telegram_message_thread_id: null,
  telegram_timeline_entry_id: "entry-1", thread_id: "thread-1",
  turn_attributes: {
    memoryScopes: ["group"], role: "owner", sandboxSessionId: "thread-0", telegramTimelineSequence: "412",
    telegramTimelineVisibleEntryIds: ["entry-0", "entry-1"], telegramTurnStartedAt: "2026-09-26T08:50:00.000Z",
    toolAllowlist: ["bash"],
  },
};

function client() {
  return { query: vi.fn(async () => ({ rowCount: 1, rows: [{ family_id: "fam-1", role: "member", user_id: "user-1" }] })) } as never;
}

describe("resolveCurrentApprovalAuth", () => {
  it("restores the requesting turn's context under freshly read policy", async () => {
    const auth = await resolveCurrentApprovalAuth(client(), row);

    expect(auth?.attributes).toMatchObject({
      applicationSessionId: "app-1", memoryScopes: ["personal", "family"], role: "member", sandboxSessionId: "thread-0",
      telegramConversationId: "conv-1", telegramTimelineEntryId: "entry-1", telegramTimelineSequence: "412",
      telegramTimelineVisibleEntryIds: ["entry-0", "entry-1"], telegramTurnStartedAt: "2026-09-26T08:50:00.000Z",
    });
    expect(auth?.attributes).not.toHaveProperty("toolAllowlist");
  });

  it("falls back to the session's thread as the sandbox when no snapshot was kept", async () => {
    const auth = await resolveCurrentApprovalAuth(client(), { ...row, turn_attributes: null });

    expect(auth?.attributes.sandboxSessionId).toBe("thread-1");
    expect(auth?.attributes).not.toHaveProperty("telegramTimelineSequence");
  });

  it("carries the visible entries memory sources need to bind after the tap", async () => {
    // Без telegramTimelineVisibleEntryIds привязка источников памяти падала с turn_attributes_invalid
    // на каждом ходе, возобновлённом кнопкой.
    const auth = await resolveCurrentApprovalAuth(client(), row);

    expect(Array.isArray(auth?.attributes.telegramTimelineVisibleEntryIds)).toBe(true);
  });
});

describe("retainTurnAttributes", () => {
  it("keeps context keys only", () => {
    expect(retainTurnAttributes({ role: "owner", sandboxSessionId: "s", telegramTimelineSequence: "7", telegramUserId: "104", x: 1 }))
      .toEqual({ sandboxSessionId: "s", telegramTimelineSequence: "7" });
    expect(retainTurnAttributes(undefined)).toEqual({});
  });
});
