/**
 * Light capacity measurement on the test stand: `stress/telegram-conversation/evals/capacity.eval.ts`.
 *
 * Runtime:
 * - Runs inside the `capacity` service of `compose.test.yaml` (profile `stress`) after `npm run migrate`.
 * - Prepares the conversation fixture the same way the end-to-end test does (trusted config and analyst
 *   skills copied in, fixture typechecked), runs the eval and prints its `CAPACITY_SUMMARY` line.
 * - Deletes generated build, discovery, report and copied files on every exit path.
 */
import { spawn } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const fixtureRoot = resolve("stress", "telegram-conversation");
const generatedPaths = [".eve", ".output", "eval-results", "reports", "config",
  "agent/skills/auto-analyst", "agent/skills/policy-finance-analyst"];
const env = {
  ...process.env,
  NODE_ENV: "development",
  EVE_MOCK_AUTHORED_MODELS: "0",
  TELEGRAM_BOT_TOKEN: "conversation-test-token",
  TELEGRAM_BOT_USERNAME: "osinara_test_bot",
  TELEGRAM_AGENT_NAME: "Осинара",
  TELEGRAM_AGENT_ALIASES: "[]",
  TELEGRAM_WEBHOOK_SECRET_TOKEN: "conversation-test-secret-0123456789abcdef",
  AGENT_INTERNAL_TOKEN: "conversation-internal-token-0123456789abcdef",
  MODEL_API_KEY: "unused-test-key",
  MEMORY_EMBEDDING_BASE_URL: "http://memory-test",
};

function run(command: string, args: string[], cwd = process.cwd()): Promise<void> {
  const child = spawn(command, args, { cwd, env, stdio: "inherit" });
  return new Promise((resolveRun, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)));
  });
}

try {
  await cp(resolve("config"), resolve(fixtureRoot, "config"), { recursive: true });
  for (const skill of ["auto-analyst", "policy-finance-analyst"]) {
    await cp(resolve("agent/skills", skill), resolve(fixtureRoot, "agent/skills", skill), { recursive: true });
  }
  await run(resolve("node_modules/.bin/tsc"), ["--project", resolve(fixtureRoot, "tsconfig.json")]);
  await run(resolve("node_modules/.bin/eve"),
    ["eval", "capacity", "--max-concurrency", "1", "--timeout", "900000", "--verbose"], fixtureRoot);
} finally {
  await Promise.all(generatedPaths.map((path) => rm(resolve(fixtureRoot, path), { force: true, recursive: true })));
}
