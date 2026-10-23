/**
 * Telegram preparation for messages sent while a turn works.
 *
 * Constructs covered:
 * - An ingress turn of a trusted chat gets a fresh marker in its trusted auth and its own context.
 * - A message this conversation's running turn already saw arrives with a trusted notice; a message
 *   shown only as a notice (voice without transcript, a file) says so instead.
 * - A message never delivered to this conversation, or prepared outside the ingress, carries neither.
 * - A series whose earlier messages a running turn already showed says so for them too.
 * - An external group and a bot author never get a marker, so their queue is never consulted.
 */
import { describe, expect, it } from "vitest";

import { BOT_USERNAME, groupMessage, privateMessage, repositories, telegramContext } from "./telegram-on-message.test-fixtures.js";

// Another bot writes into the group; Bot-to-Bot mode delivers it with `isBot: true`.
function botGroupMessage(text: string) {
  const message = groupMessage(text);
  return { ...message, from: { firstName: "Другой бот", id: "telegram-999", isBot: true, username: "other_bot" } };
}
import { createTelegramMessageHandler } from "./telegram-on-message.js";
import { TELEGRAM_UPDATE_MARKER_KEY } from "./telegram-update-marker.js";
import { TELEGRAM_SERIES_MARKER_KEY } from "./telegram-message-series.js";
import { alreadySeenSeriesContext, alreadySeenTurnContext, turnInterjectionMarkerContext } from "./turn-interjection/turn-interjection-block.js";

const INGRESS_UPDATE_ID = "501";
// The durable ingress stamps the update id into the message before Eve dispatch.
function fromIngress<T extends { raw: Record<string, unknown> }>(message: T): T {
  return { ...message, raw: { ...message.raw, [TELEGRAM_UPDATE_MARKER_KEY]: INGRESS_UPDATE_ID } };
}
const GROUP = {
  familyId: "family-1",
  groupId: "group-1",
  messageMode: "all" as const,
  skillAllowlist: [],
  telegramChatId: "group-101",
  toolAllowlist: [],
};

function ownerRepositories() {
  const repository = repositories();
  repository.telegram.findIdentity.mockResolvedValue({ familyId: "family-1", role: "owner", userId: "user-1" });
  return repository;
}

describe("turn interjection preparation", () => {
  it("announces a fresh marker in trusted auth and in the turn's own context", async () => {
    const handler = createTelegramMessageHandler(ownerRepositories());

    const first = await handler(telegramContext().context, fromIngress(privateMessage("найди билеты")));
    const second = await handler(telegramContext().context, fromIngress(privateMessage("найди билеты")));

    const marker = first?.auth?.attributes.telegramTurnInterjectionMarker;
    expect(marker).toMatch(/^[0-9a-f]{24}$/u);
    expect(first?.context).toContain(turnInterjectionMarkerContext(marker as string));
    expect(second?.auth?.attributes.telegramTurnInterjectionMarker).not.toBe(marker);
  });

  it("announces a marker for an addressed member of a family group", async () => {
    const repository = ownerRepositories();
    repository.telegram.findGroup.mockResolvedValue({ ...GROUP, type: "family_private" });
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(telegramContext().context, fromIngress(groupMessage(`@${BOT_USERNAME} найди`)));

    expect(result?.auth?.attributes.telegramTurnInterjectionMarker).toMatch(/^[0-9a-f]{24}$/u);
  });

  it.each([
    ["an external group member", { ...GROUP, type: "external" as const }, () => groupMessage(`@${BOT_USERNAME} найди`)],
    ["another bot", { ...GROUP, type: "external" as const }, () => botGroupMessage(`@${BOT_USERNAME} найди`)],
  ])("prepares no marker for %s", async (_label, group, message) => {
    const repository = ownerRepositories();
    repository.telegram.findGroup.mockResolvedValue(group);
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(telegramContext().context, fromIngress(message()));

    expect(result).not.toBeNull();
    expect(result?.auth?.attributes).not.toHaveProperty("telegramTurnInterjectionMarker");
    expect(result?.context?.join("\n")).not.toContain("turn_interjection_marker");
  });

  it("prepares no marker outside the durable ingress", async () => {
    const handler = createTelegramMessageHandler(ownerRepositories());

    const result = await handler(telegramContext().context, privateMessage("привет"));

    expect(result?.auth?.attributes).not.toHaveProperty("telegramTurnInterjectionMarker");
    expect(result?.context?.join("\n")).not.toContain("turn_interjection_marker");
  });

  it("tells the agent it already saw the text in this conversation", async () => {
    const repository = ownerRepositories();
    repository.turnInterjections.findDeliveredContentKind.mockResolvedValue("text");
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(telegramContext().context, fromIngress(privateMessage("Стоп, Питер")));

    expect(repository.turnInterjections.findDeliveredContentKind).toHaveBeenCalledWith("501", "session-1");
    expect(result?.context).toContain(alreadySeenTurnContext("text"));
  });

  it("says the agent saw only a notice when the content was not shown", async () => {
    const repository = ownerRepositories();
    repository.turnInterjections.findDeliveredContentKind.mockResolvedValue("notice");
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(telegramContext().context, fromIngress(privateMessage("фото")));

    expect(result?.context).toContain(alreadySeenTurnContext("notice"));
  });

  // Review 28 September 2026: B was shown while turn A worked, then B and C were merged into a series
  // answered by C; B came back as an earlier message without any notice.
  it("tells the agent which earlier messages of the series it already saw", async () => {
    const repository = ownerRepositories();
    repository.turnInterjections.findDeliveredContentKinds.mockResolvedValue(new Map([["499", "text"], ["500", "notice"]]));
    const handler = createTelegramMessageHandler(repository);
    const message = fromIngress(privateMessage("и ещё сыр"));
    const series = { ...message, raw: { ...message.raw, [TELEGRAM_SERIES_MARKER_KEY]: { addressed: true, earlierUpdateIds: ["499", "500"], role: "current", telegramMessageIds: ["41", "42"] } } };

    const result = await handler(telegramContext().context, series);

    expect(repository.turnInterjections.findDeliveredContentKinds).toHaveBeenCalledWith(["499", "500"], "session-1");
    expect(result?.context).toContain(alreadySeenSeriesContext(1));
  });

  it("adds no notice for a message this conversation never saw", async () => {
    const repository = ownerRepositories();
    const handler = createTelegramMessageHandler(repository);

    const shown = await handler(telegramContext().context, fromIngress(privateMessage("привет")));
    expect(shown?.context?.join("\n")).not.toContain("предыдущего хода");

    const direct = await handler(telegramContext().context, privateMessage("привет"));
    expect(direct?.context?.join("\n")).not.toContain("предыдущего хода");
    expect(repository.turnInterjections.findDeliveredContentKind).toHaveBeenCalledTimes(1);
  });
});