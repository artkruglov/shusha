/**
 * Сигналы «что человек попробовал»: инструменты хода становятся ключами возможностей, только в личном чате и
 * семейной группе, один раз за ход; внешняя группа, сабагент, расписание и чужой бот не считаются.
 */
import { describe, expect, it, vi } from "vitest";

import { featureOfTool } from "./feature-catalog.js";
import { createFeatureUseHandlers } from "./feature-use-signals.js";

const FAMILY = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function ctx(attributes: Record<string, unknown>, extra: { channel?: string; principalId?: string } = {}) {
  return {
    channel: { kind: extra.channel ?? "telegram" },
    session: {
      auth: { current: { attributes, authenticator: "telegram", principalId: extra.principalId ?? USER } },
      id: "session-1",
    },
  } as never;
}

const privateChat = { familyId: FAMILY, role: "member", telegramChatType: "private" };
const call = (toolName: string) => ({ kind: "tool-call", toolName });
const NOW = new Date("2026-10-21T10:00:00Z");

describe("feature use signals", () => {
  it("maps tools to abilities", () => {
    expect(featureOfTool("generate_image")).toBe("image");
    expect(featureOfTool("generate_video")).toBe("video");
    expect(featureOfTool("inspect_workspace_image")).toBe("photo");
    expect(featureOfTool("manage_reminder")).toBe("reminder");
    expect(featureOfTool("grocery_cart")).toBe("grocery");
    expect(featureOfTool("manage_shopping_list")).toBe("shopping");
    expect(featureOfTool("execute_google_workspace")).toBe("google");
    expect(featureOfTool("web_search")).toBe("web_search");
    expect(featureOfTool("web_fetch")).toBe("web_search");
    expect(featureOfTool("remember")).toBeNull();
    expect(featureOfTool("toString")).toBeNull();
  });

  it("records each ability once per turn for the person in their private chat", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const handlers = createFeatureUseHandlers({ record });
    await handlers.actionsRequested(
      { data: { actions: [call("web_search"), call("web_search"), call("remember"), call("generate_image")], turnId: "t1" } },
      ctx(privateChat), NOW);
    await handlers.actionsRequested({ data: { actions: [call("web_fetch"), call("manage_reminder")], turnId: "t1" } }, ctx(privateChat), NOW);
    await handlers.actionsRequested({ data: { actions: [call("web_search")], turnId: "t2" } }, ctx(privateChat), NOW);

    expect(record.mock.calls.map(([input]) => input.features)).toEqual([["web_search", "image"], ["reminder"], ["web_search"]]);
    expect(record).toHaveBeenCalledWith({ familyId: FAMILY, features: ["web_search", "image"], now: NOW, userId: USER });
  });

  it("counts the family group and nothing else", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const handlers = createFeatureUseHandlers({ record });
    const event = { data: { actions: [call("web_search")], turnId: "t" } };
    await handlers.actionsRequested(event, ctx({ familyId: FAMILY, groupType: "family_private", telegramChatType: "supergroup" }), NOW);
    expect(record).toHaveBeenCalledTimes(1);

    for (const other of [
      ctx({ familyId: FAMILY, groupType: "external", telegramChatType: "supergroup" }),
      ctx({ familyId: FAMILY, groupType: "ordinary", telegramChatType: "supergroup" }),
      ctx(privateChat, { channel: "subagent" }),
      ctx({ ...privateChat, scheduledRunId: "run-1" }),
      ctx({ ...privateChat, memoryReviewMode: "background" }),
      ctx({ familyId: FAMILY, groupType: "family_private", telegramChatType: "supergroup" }, { principalId: "telegram-bot:42" }),
      ctx({ role: "member", telegramChatType: "private" }),
    ]) {
      await handlers.actionsRequested({ data: { actions: [call("web_search")], turnId: `t-${Math.random()}` } }, other, NOW);
    }
    expect(record).toHaveBeenCalledTimes(1);
  });
});
