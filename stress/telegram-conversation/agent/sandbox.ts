/** Run the production sandbox hook and its live mount checks over an in-process test filesystem. */
import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import productionSandbox from "../../../agent/sandbox.js";
import { database } from "../../../agent/lib/database.js";

export default defineSandbox({
  backend: justbash(),
  async onSession(input) {
    if (!productionSandbox.onSession) throw new Error("TEST_SANDBOX_HOOK_MISSING");
    await productionSandbox.onSession({
      ...input,
      async use(options) {
        const attrs = input.ctx.session.auth.current?.attributes;
        // A group without a family (migration 175) has no family attribute and no workspace at all.
        const familyless = attrs !== undefined && !Object.hasOwn(attrs, "familyId");
        const expected = familyless ? [] : attrs?.telegramChatType === "private" ? ["personal", "family"] :
          attrs?.groupType === "family_private" ? ["family"] : ["group"];
        if (!options || JSON.stringify(options.mounts.map((mount) => mount.mountPoint)) !== JSON.stringify(expected)) {
          throw new Error(`TEST_GROUP_MOUNTS_INVALID: ${JSON.stringify(options?.mounts)} expected ${JSON.stringify(expected)}`);
        }
        await database().query(
          "INSERT INTO telegram_conversation_test_sandboxes (eve_session_id, mounts) VALUES ($1, $2)",
          [input.ctx.session.id, JSON.stringify(options.mounts)],
        );
        return input.use();
      },
    });
  },
});
