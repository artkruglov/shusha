/**
 * The Telegram webhook checks its secret-token header before the body is read.
 *
 * Eve 0.40.0 reads the whole request body in `verifyTelegramRequest` first and only then compares the
 * header, so an unauthenticated caller of the public webhook could make the server buffer a large body
 * (security review of ilkruglov, 5 October 2026, commit 87b73f55). The custom-verifier branch needs the
 * body and is unchanged.
 */
export async function patchWebhookVerifyFirst(replace: (path: string, before: string, after: string) => Promise<void>) {
  const verify = "node_modules/eve/dist/src/public/channels/telegram/verify.js";
  await replace(verify,
    "async function verifyTelegramRequest(e,t){let n=await e.text();if(t.webhookVerifier!==void 0){let r=await t.webhookVerifier(e,n);",
    "async function verifyTelegramRequest(e,t){if(t.webhookVerifier!==void 0){let n=await e.text(),r=await t.webhookVerifier(e,n);");
  await replace(verify,
    "if(!constantTimeCompare(r,i))throw Error(`telegramChannel: inbound request secret-token mismatch.`);return n}",
    "if(!constantTimeCompare(r,i))throw Error(`telegramChannel: inbound request secret-token mismatch.`);return await e.text()}");
}
