/**
 * `publish_memory` tool contract tests.
 *
 * Constructs covered:
 * - A near-duplicate stop in the target area is an ordinary answer with the similar records; the
 *   thrown stop carried the code alone (a thrown tool error is logged whole).
 * - Any other failure of the copy is thrown unchanged.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { previewPublication, publishMemory } = vi.hoisted(() => ({
  previewPublication: vi.fn(),
  publishMemory: vi.fn(),
}));

vi.mock("../memory-context.js", () => ({
  requireMemoryAuthorization: () => ({ familyId: "family-1", scopes: ["family"] }),
}));
vi.mock("../relay/memory-publication.js", () => ({
  listPublicationTargets: vi.fn(),
  previewPublication,
  publishMemory,
}));
import { NearDuplicateRefusal } from "../memory-near-duplicate.js";
import publishMemoryTool from "./publish_memory.js";

const MEMORY_REF = "mem_0123456789abcdef0123456789abcdef";
const AREA_REF = "00000000-0000-4000-8000-000000000002";
const context = {
  callId: "call-1",
  session: { id: "session-1", turn: { id: "turn-1" } },
} as unknown as ToolContext;

describe("publish_memory tool", () => {
  beforeEach(() => {
    previewPublication.mockReset();
    publishMemory.mockReset();
    previewPublication.mockResolvedValue({
      content: "Семейный попугай Гоша живёт дома", kind: "fact", readers: ["Анна"], targetTitle: "Дача",
    });
  });

  it("answers a near-duplicate stop in the target area with the similar records", async () => {
    const refusal = new NearDuplicateRefusal([
      { attribute: null, content: "Гоша, кубинский амазон, живёт дома", memoryRef: MEMORY_REF, similarity: 0.71 },
    ]);
    expect(refusal.message).toBe("AGENT_MEMORY_NEAR_DUPLICATE");
    publishMemory.mockRejectedValue(refusal);

    const result = await publishMemoryTool.execute(
      { action: "publish", areaRef: AREA_REF, memoryRef: MEMORY_REF },
      context,
    );

    expect(result).toEqual({
      code: "AGENT_MEMORY_NEAR_DUPLICATE",
      instruction: expect.stringContaining("копия не создана"),
      published: false,
      similar: [{ attribute: null, content: "Гоша, кубинский амазон, живёт дома", memoryRef: MEMORY_REF }],
    });
  });

  it("rethrows any other failure of the copy", async () => {
    publishMemory.mockRejectedValue(Object.assign(new Error("denied"), { code: "AGENT_MEMORY_PUBLISH_DENIED" }));

    await expect(publishMemoryTool.execute(
      { action: "publish", areaRef: AREA_REF, memoryRef: MEMORY_REF },
      context,
    )).rejects.toThrow("denied");
  });
});
