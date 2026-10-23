/**
 * Payload blob split and join tests.
 *
 * Constructs covered:
 * - A compressed devalue payload with two large strings (one twice) splits into two blobs and
 *   joins back to the same JSON; the stored form is far smaller.
 * - A plain (uncompressed) payload keeps its form through the round trip.
 * - Payloads with nothing large, non-devalue bytes and foreign prefixes are left alone.
 * - A missing blob is an error, not a silent hole.
 * - A large string with a lone surrogate stays inline: UTF-8 cannot carry it back.
 * - The cache keeps the newest blobs within its budget.
 */
import { createHash } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  createPayloadBlobCache, escapePayload, hasLoneSurrogate, isEscapedPayload, isSplitPayload, joinPayload, PAYLOAD_BLOB_MARKER_KEY,
  payloadBlobHash, payloadBlobHashes, splitPayload, unescapePayload,
} from "./payload-blobs.ts";

// About 7.8 KB of poorly compressible text, so sizes mean something.
const big = (seed: string) => Array.from({ length: 120 }, (_, i) => createHash("sha256").update(`${seed}${i}`).digest("hex")).join(" ");
const devalue = (flat: unknown[]) => Buffer.concat([Buffer.from("devl"), Buffer.from(JSON.stringify(flat))]);
const compressed = (body: Buffer) => new Uint8Array(Buffer.concat([Buffer.from("zstd"), zstdCompressSync(body)]));
const unwrap = (bytes: Uint8Array) => {
  const buffer = Buffer.from(bytes);
  const prefix = buffer.subarray(0, 4).toString();
  // `zstd` wraps a prefixed body; `oblz` wraps the marked JSON itself.
  if (prefix === "zstd") { const body = zstdDecompressSync(buffer.subarray(4)); return { prefix: body.subarray(0, 4).toString(), json: JSON.parse(body.subarray(4).toString()) as unknown[] }; }
  if (prefix === "oblz") return { prefix, json: JSON.parse(zstdDecompressSync(buffer.subarray(4)).toString()) as unknown[] };
  return { prefix, json: JSON.parse(buffer.subarray(4).toString()) as unknown[] };
};

describe("payload blobs", () => {
  it("lifts large top-level strings into blobs and restores the payload exactly", () => {
    const flat = [{ system: 1, history: 2, again: 1, small: 3 }, big("system prompt"), big("history"), "short", ["Date", 1]];
    const original = compressed(devalue(flat));
    const split = splitPayload(original);
    expect(split).not.toBeNull();
    expect([...split!.blobs.keys()].sort()).toEqual([payloadBlobHash(big("history")), payloadBlobHash(big("system prompt"))].sort());
    expect(split!.stored.length).toBeLessThan(original.length / 4);
    expect(isSplitPayload(split!.stored)).toBe(true);
    expect(payloadBlobHashes(split!.stored).sort()).toEqual([...split!.blobs.keys()].sort());
    const stored = unwrap(split!.stored);
    expect(stored.prefix).toBe("oblz");
    expect(stored.json[1]).toEqual({ [PAYLOAD_BLOB_MARKER_KEY]: payloadBlobHash(big("system prompt")) });
    expect(stored.json[3]).toBe("short");

    const joined = joinPayload(split!.stored, (hash) => split!.blobs.get(hash));
    expect(unwrap(joined)).toEqual({ prefix: "devl", json: flat });
    expect(Buffer.from(joined).subarray(0, 4).toString()).toBe("zstd");
  });

  it("keeps an uncompressed payload uncompressed", () => {
    const original = new Uint8Array(devalue([{ a: 1 }, big("x")]));
    const split = splitPayload(original)!;
    expect(unwrap(split.stored).prefix).toBe("oblb");
    const joined = joinPayload(split.stored, (hash) => split.blobs.get(hash));
    expect(Buffer.from(joined).subarray(0, 4).toString()).toBe("devl");
    expect(unwrap(joined).json).toEqual([{ a: 1 }, big("x")]);
  });

  it("leaves payloads without large strings, foreign bytes and already restored bytes alone", () => {
    const small = new Uint8Array(devalue([{ a: 1 }, "tiny"]));
    expect(splitPayload(small)).toBeNull();
    expect(isSplitPayload(small)).toBe(false);
    expect(joinPayload(small, () => undefined)).toBe(small);
    const foreign = new Uint8Array(Buffer.from("cbor-or-anything"));
    expect(splitPayload(foreign)).toBeNull();
    expect(payloadBlobHashes(foreign)).toEqual([]);
    expect(splitPayload(new Uint8Array(Buffer.from("devl{not an array}")))).toBeNull();
  });

  it("keeps a string with a lone surrogate inline, since UTF-8 would not bring it back", () => {
    const lone = `${big("lone")}\ud83d`;
    expect(hasLoneSurrogate(lone)).toBe(true);
    expect(hasLoneSurrogate(`${big("pair")}\ud83d\ude00`)).toBe(false);
    expect(Buffer.from(lone, "utf8").toString("utf8")).not.toBe(lone);
    const flat = [{ a: 1, b: 2 }, lone, big("fine")];
    const split = splitPayload(compressed(devalue(flat)))!;
    expect([...split.blobs.keys()]).toEqual([payloadBlobHash(big("fine"))]);
    expect(unwrap(split.stored).json[1]).toBe(lone);
    expect(unwrap(joinPayload(split.stored, (hash) => split.blobs.get(hash))).json).toEqual(flat);
    expect(splitPayload(compressed(devalue([lone])))).toBeNull();
  });

  it("refuses to restore a payload whose blob is gone", () => {
    const split = splitPayload(compressed(devalue([big("y")])))!;
    expect(() => joinPayload(split.stored, () => undefined)).toThrow("AGENT_WORKFLOW_PAYLOAD_BLOB_MISSING");
  });

  it("escapes opaque bytes that start like a stored envelope and nothing else", () => {
    for (const prefix of ["oblb", "oblz", "oblr"]) {
      const opaque = new Uint8Array(Buffer.from(`${prefix}raw bytes`));
      const escaped = escapePayload(opaque);
      expect(Buffer.from(escaped).subarray(0, 4).toString()).toBe("oblr");
      expect(isEscapedPayload(escaped)).toBe(true);
      expect(isSplitPayload(escaped)).toBe(false);
      expect(splitPayload(escaped)).toBeNull();
      expect(Buffer.from(unescapePayload(escaped)).equals(Buffer.from(opaque))).toBe(true);
    }
    const plain = new Uint8Array(devalue([{ a: 1 }, "x"]));
    expect(escapePayload(plain)).toBe(plain);
    expect(unescapePayload(plain)).toBe(plain);
  });

  it("caches the newest blobs within the budget", () => {
    const cache = createPayloadBlobCache(25);
    cache.set("a", new Uint8Array(10));
    cache.set("b", new Uint8Array(10));
    expect(cache.get("a")).toBeDefined();
    cache.set("c", new Uint8Array(10));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.size).toBe(20);
    // An entry above the whole budget is not kept and evicts nothing.
    cache.set("huge", new Uint8Array(30));
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.size).toBe(20);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});
