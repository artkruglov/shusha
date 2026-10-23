/**
 * Checksum-pinned Google Workspace CLI binary installer for Docker builds.
 *
 * Exports:
 * - `GWS_VERSION`: exact npm package and release version.
 * - `resolveGoogleWorkspaceCliArtifact`: Linux architecture to official artifact/checksum mapping.
 * - `resolveGoogleWorkspaceCliVendoredPath`: the archive kept in the repository, if any.
 * - `resolveGoogleWorkspaceCliDownloadUrl`: official GitHub release URL for a pinned artifact.
 * - `installGoogleWorkspaceCli`: verified archive (vendored, else downloaded) extracted into the package.
 *
 * Key construct:
 * - The archive for the x86_64 image lives in vendor/google-workspace-cli, so an image build does
 *   not depend on GitHub: on 4 October 2026 the download failed four builds in a row (a 403 from
 *   the release-assets API, whose unauthenticated limit is sixty calls an hour per address, and
 *   timeouts). A download, when needed, goes to the direct release URL and is retried.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const GWS_VERSION = "0.22.5";

const DOWNLOAD_TIMEOUT_MILLISECONDS = 120_000;
const GWS_PACKAGE_DIRECTORY = resolve("node_modules/@googleworkspace/cli");
const GWS_VENDOR_DIRECTORY = resolve("vendor/google-workspace-cli");
const GWS_RELEASE_DOWNLOAD_BASE_URL = "https://github.com/googleworkspace/cli/releases/download";
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MILLISECONDS = 5_000;
const execFileAsync = promisify(execFile);

interface GoogleWorkspaceCliArtifact {
  archiveName: string;
  releaseAssetId: number;
  sha256: string;
}

const LINUX_ARTIFACTS: Readonly<Record<string, GoogleWorkspaceCliArtifact>> = {
  arm64: {
    archiveName: "google-workspace-cli-aarch64-unknown-linux-musl.tar.gz",
    releaseAssetId: 385726968,
    sha256: "e700fe63524932b10ec2130b47ece90aa850e66005fe52ccfc4cf8767bf9919a",
  },
  x64: {
    archiveName: "google-workspace-cli-x86_64-unknown-linux-musl.tar.gz",
    releaseAssetId: 385726987,
    sha256: "4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920",
  },
};

export function resolveGoogleWorkspaceCliArtifact(
  platform: string,
  architecture: string,
): GoogleWorkspaceCliArtifact {
  const artifact = platform === "linux" ? LINUX_ARTIFACTS[architecture] : undefined;
  if (!artifact) {
    throw new Error(
      `AGENT_GWS_PLATFORM_UNSUPPORTED: Unsupported gws target ${platform}/${architecture}`,
    );
  }
  return artifact;
}

export function resolveGoogleWorkspaceCliDownloadUrl(
  artifact: GoogleWorkspaceCliArtifact,
): string {
  return `${GWS_RELEASE_DOWNLOAD_BASE_URL}/v${GWS_VERSION}/${artifact.archiveName}`;
}

/** The repository's copy of the archive for this artifact, or null when it is not kept. */
export async function resolveGoogleWorkspaceCliVendoredPath(
  artifact: GoogleWorkspaceCliArtifact,
  vendorDirectory = GWS_VENDOR_DIRECTORY,
): Promise<string | null> {
  const path = join(vendorDirectory, artifact.archiveName);
  try {
    await access(path);
    return path;
  } catch {
    return null;
  }
}

function verifiedArchive(archive: Buffer, artifact: GoogleWorkspaceCliArtifact): Buffer {
  const actualHash = createHash("sha256").update(archive).digest("hex");
  if (actualHash !== artifact.sha256) {
    throw new Error(
      `AGENT_GWS_CHECKSUM_MISMATCH: Expected ${artifact.sha256}, received ${actualHash}`,
    );
  }
  return archive;
}

async function downloadVerifiedArchive(artifact: GoogleWorkspaceCliArtifact): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(resolveGoogleWorkspaceCliDownloadUrl(artifact), {
        headers: { Accept: "application/octet-stream" },
        redirect: "follow",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MILLISECONDS),
      });
      if (!response.ok) {
        throw new Error(
          `AGENT_GWS_DOWNLOAD_FAILED: Official release returned HTTP ${response.status} for gws ${GWS_VERSION}`,
        );
      }
      return verifiedArchive(Buffer.from(await response.arrayBuffer()), artifact);
    } catch (error) {
      lastError = error;
      // A checksum mismatch is not a network condition; retrying would download the same bytes.
      if (error instanceof Error && error.message.startsWith("AGENT_GWS_CHECKSUM_MISMATCH")) throw error;
      console.warn(`gws download attempt ${attempt} of ${DOWNLOAD_ATTEMPTS} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_RETRY_DELAY_MILLISECONDS * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** The vendored archive when the repository keeps one for this artifact, else a download. */
async function obtainVerifiedArchive(artifact: GoogleWorkspaceCliArtifact): Promise<Buffer> {
  const vendored = await resolveGoogleWorkspaceCliVendoredPath(artifact);
  if (vendored !== null) {
    console.log(`gws ${GWS_VERSION}: using vendored ${artifact.archiveName}`);
    return verifiedArchive(await readFile(vendored), artifact);
  }
  return downloadVerifiedArchive(artifact);
}

export async function installGoogleWorkspaceCli(): Promise<void> {
  const artifact = resolveGoogleWorkspaceCliArtifact(process.platform, process.arch);
  const packageManifest = JSON.parse(
    await readFile(join(GWS_PACKAGE_DIRECTORY, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (packageManifest.version !== GWS_VERSION) {
    throw new Error(
      `AGENT_GWS_VERSION_MISMATCH: Expected npm package ${GWS_VERSION}, received ${String(packageManifest.version)}`,
    );
  }

  const installDirectory = join(GWS_PACKAGE_DIRECTORY, "bin");
  const binaryPath = join(installDirectory, "gws");
  const versionPath = join(installDirectory, ".version");
  const installationMarker = `${GWS_VERSION}:${artifact.archiveName}`;
  try {
    const installedVersion = (await readFile(versionPath, "utf8")).trim();
    await access(binaryPath);
    if (installedVersion === installationMarker) return;
  } catch {
    // A clean npm install has no binary; any partial directory is replaced below.
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "osinara-gws-install-"));
  const archivePath = join(temporaryDirectory, artifact.archiveName);
  try {
    const archive = await obtainVerifiedArchive(artifact);
    await writeFile(archivePath, archive, { mode: 0o600 });
    await rm(installDirectory, { force: true, recursive: true });
    await mkdir(installDirectory, { mode: 0o755, recursive: true });
    await execFileAsync("tar", ["xf", archivePath, "-C", installDirectory]);
    await access(binaryPath);
    await chmod(binaryPath, 0o755);
    await writeFile(versionPath, `${installationMarker}\n`, { mode: 0o644 });
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  await installGoogleWorkspaceCli();
}
