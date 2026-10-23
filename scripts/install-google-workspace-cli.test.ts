/**
 * Checksum-pinned gws installer tests.
 *
 * Constructs covered:
 * - Supported Docker architectures resolve exact official artifacts and SHA-256 digests.
 * - Release downloads use the official GitHub origin without a third-party proxy.
 * - Unsupported platforms fail before any download occurs.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  GWS_VERSION,
  resolveGoogleWorkspaceCliArtifact,
  resolveGoogleWorkspaceCliDownloadUrl,
  resolveGoogleWorkspaceCliVendoredPath,
} from "./install-google-workspace-cli.js";

describe("Google Workspace CLI installer", () => {
  it("pins the exact x64 and arm64 release artifacts", () => {
    expect(resolveGoogleWorkspaceCliArtifact("linux", "x64")).toEqual({
      archiveName: "google-workspace-cli-x86_64-unknown-linux-musl.tar.gz",
      releaseAssetId: 385726987,
      sha256: "4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920",
    });
    expect(resolveGoogleWorkspaceCliArtifact("linux", "arm64")).toEqual({
      archiveName: "google-workspace-cli-aarch64-unknown-linux-musl.tar.gz",
      releaseAssetId: 385726968,
      sha256: "e700fe63524932b10ec2130b47ece90aa850e66005fe52ccfc4cf8767bf9919a",
    });
  });

  it("downloads a pinned artifact from the release's direct URL, not the rate-limited API", () => {
    const artifact = resolveGoogleWorkspaceCliArtifact("linux", "x64");

    expect(resolveGoogleWorkspaceCliDownloadUrl(artifact)).toBe(
      `https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/google-workspace-cli-x86_64-unknown-linux-musl.tar.gz`,
    );
  });

  // Four image builds failed on this download on 4 October 2026; the x86_64 archive now ships in
  // the repository and must match the pinned digest.
  it("keeps the x64 archive in vendor with the pinned digest and nothing for arm64", async () => {
    const x64 = resolveGoogleWorkspaceCliArtifact("linux", "x64");
    const vendored = await resolveGoogleWorkspaceCliVendoredPath(x64);
    expect(vendored).toMatch(/vendor\/google-workspace-cli\/google-workspace-cli-x86_64-unknown-linux-musl\.tar\.gz$/u);
    const digest = createHash("sha256").update(await readFile(vendored!)).digest("hex");
    expect(digest).toBe(x64.sha256);
    expect(await resolveGoogleWorkspaceCliVendoredPath(resolveGoogleWorkspaceCliArtifact("linux", "arm64"))).toBeNull();
  });

  it("rejects non-Linux and unsupported CPU targets", () => {
    expect(() => resolveGoogleWorkspaceCliArtifact("darwin", "x64")).toThrowError(
      /AGENT_GWS_PLATFORM_UNSUPPORTED/,
    );
    expect(() => resolveGoogleWorkspaceCliArtifact("linux", "riscv64")).toThrowError(
      /AGENT_GWS_PLATFORM_UNSUPPORTED/,
    );
  });
});
