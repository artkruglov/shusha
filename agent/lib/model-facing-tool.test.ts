/**
 * Model-facing tool boundary tests.
 *
 * Constructs covered:
 * - `wrapModelFacingTool`: preserves successful output, normalizes thrown failures, and marks a
 *   result once the turn's pre-tool text has been delivered.
 * - `wrapModelFacingToolMap`: applies the same boundary to a complete mode surface.
 */
import { defineTool, type ToolDefinition } from "eve/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AppError } from "./app-error.js";
import { currentDatabaseContext } from "./database-context.js";
import { jsonSafeToolOutput, wrapModelFacingTool, wrapModelFacingToolMap } from "./model-facing-tool.js";
import {
  PROGRESS_NOTICE_SENT_NOTE,
  progressNoticeKey,
  telegramProgressNoticeDeferral,
} from "./telegram-progress-deferral.js";

function tool(execute: () => unknown) {
  return defineTool({
    description: "Test tool",
    inputSchema: z.object({}).strict(),
    execute,
  }) as ToolDefinition<any, any>;
}

describe("model-facing tool boundary", () => {
  it("preserves successful outputs and descriptor metadata", async () => {
    const source = tool(() => ({ ok: true }));
    const wrapped = wrapModelFacingTool("test_tool", source);

    await expect(wrapped.execute({}, {} as never)).resolves.toEqual({ ok: true });
    // Generic call discipline lives in the permanent instructions, not in every descriptor.
    expect(wrapped.description).toBe(source.description);
    expect(wrapped.inputSchema).toBe(source.inputSchema);
  });

  // Eve rejects anything but plain JSON; pg rows carry Date objects for timestamp columns.
  it("hands Eve plain JSON: dates and bigints inside results become strings", async () => {
    const created = new Date("2026-09-29T19:43:27.379Z");
    const wrapped = wrapModelFacingTool("test_tool", tool(() => ({ id: "c1", created_at: created, runs: [{ finished_at: created, count: 3n }], none: null })));
    await expect(wrapped.execute({}, {} as never)).resolves.toEqual({
      created_at: "2026-09-29T19:43:27.379Z", id: "c1", none: null, runs: [{ count: "3", finished_at: "2026-09-29T19:43:27.379Z" }],
    });
    const bytes = new Uint8Array([1, 2, 3]);
    expect((jsonSafeToolOutput({ bytes }) as { bytes: unknown }).bytes).toBe(bytes);
    expect(jsonSafeToolOutput(new Date(Number.NaN))).toBeNull();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => jsonSafeToolOutput(cyclic)).not.toThrow();
  });

  it("tells the model when its pre-tool text already reached the person", async () => {
    const wrapped = wrapModelFacingTool("generate_image", tool(() => ({ delivered: true })));
    const ctx = { session: { id: "wrun_1", turn: { id: "turn_5" } } } as never;
    const key = progressNoticeKey("wrun_1", "turn_5");
    telegramProgressNoticeDeferral.hold(key, {
      send: async () => undefined,
      stepIndex: 0,
    });
    await telegramProgressNoticeDeferral.release(key, 0, ["generate_image"]);
    try {
      await expect(wrapped.execute({}, ctx)).resolves.toEqual({
        already_sent_to_user: PROGRESS_NOTICE_SENT_NOTE,
        delivered: true,
      });
      // Another turn of the same session, and a non-object output, stay untouched.
      const other = { session: { id: "wrun_1", turn: { id: "turn_6" } } } as never;
      await expect(wrapped.execute({}, other)).resolves.toEqual({ delivered: true });
      const text = wrapModelFacingTool("read_memory_thread", tool(() => "plain text"));
      await expect(text.execute({}, ctx)).resolves.toBe("plain text");
    } finally {
      telegramProgressNoticeDeferral.forget(key);
    }
  });

  it("normalizes application and raw dependency errors for every mapped tool", async () => {
    const surface = wrapModelFacingToolMap({
      missing: tool(() => {
        throw new AppError("AGENT_MEMORY_NOT_FOUND", "Запись не найдена");
      }),
      raw: tool(() => {
        throw new Error("password=secret host=database");
      }),
    });

    await expect(surface.missing!.execute({}, {} as never)).rejects.toMatchObject({
      contract: { code: "AGENT_MEMORY_NOT_FOUND", retryable: true },
    });
    await expect(surface.raw!.execute({}, {} as never)).rejects.toMatchObject({
      contract: { code: "AGENT_TOOL_DEPENDENCY_FAILED", retryable: false },
    });
    await expect(surface.raw!.execute({}, {} as never)).rejects.not.toThrow(/secret/u);
  });

  // A verified session without a family must not fall back to the system scope: under RLS that
  // scope sees every family.
  it("refuses a verified session without a family instead of running in the system scope", async () => {
    let ran = false;
    const wrapped = wrapModelFacingTool("test_tool", tool(() => {
      ran = true;
      return { ok: true };
    }));
    const familyless = { session: { auth: { current: { attributes: { groupId: "g1", role: "external" } } } } } as never;
    await expect(wrapped.execute({}, familyless)).rejects.toMatchObject({
      contract: { code: "AGENT_DATABASE_SCOPE_MISSING" },
    });
    for (const familyId of [null, "", 42]) {
      const ctx = { session: { auth: { current: { attributes: { familyId } } } } } as never;
      await expect(wrapped.execute({}, ctx)).rejects.toMatchObject({
        contract: { code: "AGENT_DATABASE_SCOPE_MISSING" },
      });
    }
    expect(ran).toBe(false);
  });

  // A group without a family (migration 175) carries no family attribute and runs in its own scope.
  it("runs a tool of a group without a family in that group's database scope", async () => {
    const groupId = "6f1c2f9e-3b1a-4c55-9d8e-0a1b2c3d4e5f";
    const wrapped = wrapModelFacingTool("test_tool", tool(() => currentDatabaseContext()));
    const ctx = { session: { auth: { current: { attributes: { groupId, groupType: "external", role: "external", telegramChatId: "-100700" } } } } } as never;
    await expect(wrapped.execute({}, ctx)).resolves.toEqual({ groupId, kind: "group" });
    // A family group's turn that lost its family is still refused, not moved into a group scope.
    const lost = { session: { auth: { current: { attributes: { familyId: null, groupId, groupType: "external" } } } } } as never;
    await expect(wrapped.execute({}, lost)).rejects.toMatchObject({ contract: { code: "AGENT_DATABASE_SCOPE_MISSING" } });
  });
});

describe("model-facing approval boundary", () => {
  function approvalTool(approval: (ctx: unknown) => unknown) {
    return defineTool({
      approval: approval as never,
      description: "Approval tool",
      inputSchema: z.object({}).strict(),
      execute: () => ({ ok: true }),
    }) as ToolDefinition<any, any>;
  }
  const context = { toolInput: {}, toolName: "approval_tool" } as never;

  it("stops calling a tool that keeps failing in one turn, whatever the arguments", async () => {
    // 22 сентября 2026 продуктовый каталог отвечал отказом, а модель звала его 21 раз подряд с
    // новыми запросами: отпечаток «инструмент и аргументы» такую петлю не видит.
    const failing = defineTool({
      description: "Failing tool",
      inputSchema: z.object({ query: z.string() }).strict(),
      execute: () => { throw new Error("AGENT_GROCERY_UNAVAILABLE: сервис недоступен"); },
    }) as ToolDefinition<any, any>;
    const wrapped = wrapModelFacingTool("grocery_cart", failing);
    const ctx = { session: { id: "wrun_fail", turn: { id: "turn_1" } } } as never;

    for (const query of ["молоко", "хлеб", "сыр"]) {
      await expect(wrapped.execute({ query }, ctx)).rejects.toMatchObject({
        code: "AGENT_GROCERY_UNAVAILABLE",
      });
    }
    await expect(wrapped.execute({ query: "масло" }, ctx)).rejects.toMatchObject({
      code: "AGENT_TOOL_FAILING_REPEATEDLY",
    });

    // Другой ход начинается с чистого счёта, а удачный вызов снимает счёт в своём.
    const next = { session: { id: "wrun_fail", turn: { id: "turn_2" } } } as never;
    await expect(wrapped.execute({ query: "масло" }, next)).rejects.toMatchObject({
      code: "AGENT_GROCERY_UNAVAILABLE",
    });
  });

  it("turns an application input error thrown by the approval policy into a denial", async () => {
    const wrapped = wrapModelFacingTool("approval_tool", approvalTool(() => {
      throw new AppError("AGENT_TEST_INPUT_INVALID", "Передайте toolAllowlist массивом");
    }));

    await expect((wrapped.approval as (ctx: unknown) => unknown)(context)).resolves.toEqual({
      reason: "AGENT_TEST_INPUT_INVALID: Передайте toolAllowlist массивом",
      type: "denied",
    });
  });

  it("passes ordinary approval decisions through unchanged", async () => {
    const wrapped = wrapModelFacingTool("approval_tool", approvalTool(() => "user-approval"));

    expect(await (wrapped.approval as (ctx: unknown) => unknown)(context)).toBe("user-approval");
  });

  it("does not swallow unexpected failures inside the approval policy", async () => {
    const wrapped = wrapModelFacingTool("approval_tool", approvalTool(() => {
      throw new TypeError("boom");
    }));

    await expect(async () => await (wrapped.approval as (ctx: unknown) => unknown)(context))
      .rejects.toThrow("boom");
  });

  it("keeps tools without an approval policy untouched", () => {
    const wrapped = wrapModelFacingTool("plain", tool(() => ({ ok: true })));

    expect(wrapped.approval).toBeUndefined();
  });
});
