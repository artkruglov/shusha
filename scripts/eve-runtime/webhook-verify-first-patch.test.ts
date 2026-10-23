/**
 * Installed-artifact contract for the webhook verify-first patch of Eve's Telegram channel.
 *
 * Constructs covered:
 * - The installed verifier compares the secret-token header before it reads the body; the
 *   custom-verifier branch still reads the body first because it needs it.
 * - On a copy of the installed tree (Eve copied, every other package linked) with the upstream
 *   verifier restored, the installer reproduces the installed file byte for byte, twice.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const VERIFY = "dist/src/public/channels/telegram/verify.js";
const PATCHED_HEAD = "async function verifyTelegramRequest(e,t){if(t.webhookVerifier!==void 0){let n=await e.text(),r=await t.webhookVerifier(e,n);";
const UPSTREAM_HEAD = "async function verifyTelegramRequest(e,t){let n=await e.text();if(t.webhookVerifier!==void 0){let r=await t.webhookVerifier(e,n);";
const PATCHED_TAIL = "throw Error(`telegramChannel: inbound request secret-token mismatch.`);return await e.text()}";
const UPSTREAM_TAIL = "throw Error(`telegramChannel: inbound request secret-token mismatch.`);return n}";

/** A tree the installer accepts: the patched packages are copies, everything else links to the real install. */
async function copyInstalledTree(root: string): Promise<void> {
  const modules = resolve("node_modules");
  await mkdir(join(root, "node_modules/@workflow"), { recursive: true });
  for (const name of ["eve", "graphile-worker", "@workflow/world-postgres"]) {
    await cp(join(modules, name), join(root, "node_modules", name), { recursive: true });
  }
  for (const name of await readdir(modules)) {
    if (name === "eve" || name === "graphile-worker" || name === "@workflow") continue;
    await symlink(join(modules, name), join(root, "node_modules", name));
  }
  for (const name of await readdir(join(modules, "@workflow"))) {
    if (name !== "world-postgres") await symlink(join(modules, "@workflow", name), join(root, "node_modules/@workflow", name));
  }
  await symlink(resolve("scripts"), join(root, "scripts"));
}

describe("webhook verify-first patch", () => {
  it("compares the secret before reading the body in the installed verifier", async () => {
    const installed = await readFile(`node_modules/eve/${VERIFY}`, "utf8");
    expect(installed).toContain(PATCHED_HEAD);
    expect(installed).toContain(PATCHED_TAIL);
    expect(installed).not.toContain(UPSTREAM_HEAD);
    expect(installed).not.toContain(UPSTREAM_TAIL);
    await expect(execFileAsync(process.execPath, ["--check", `node_modules/eve/${VERIFY}`])).resolves.toBeDefined();
  });

  it("reproduces the installed verifier from the upstream one on a copy, and again unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-eve-verify-first-"));
    const copy = join(root, "node_modules/eve", VERIFY);
    try {
      await copyInstalledTree(root);
      const installed = await readFile(`node_modules/eve/${VERIFY}`, "utf8");
      await writeFile(copy, installed.replace(PATCHED_HEAD, UPSTREAM_HEAD).replace(PATCHED_TAIL, UPSTREAM_TAIL), "utf8");
      expect(await readFile(copy, "utf8")).not.toBe(installed);

      for (const run of [1, 2]) {
        await expect(execFileAsync(process.execPath, ["--experimental-strip-types", resolve("scripts/apply-eve-patches.ts")], { cwd: root }))
          .resolves.toBeDefined();
        expect(await readFile(copy, "utf8"), `run ${run}`).toBe(installed);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);
});
