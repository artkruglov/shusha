/**
 * The `browser` tool: the logged-in Chrome of the chat, driven by typed actions.
 *
 * Export:
 * - Eve `browser` tool (private chats and family groups).
 *
 * Key constructs:
 * - The browser runs in the session's companion container, so the model's Bash cannot reach its
 *   cookies; this tool is the only way to it and offers no action that hands the session out
 *   (`browser-command.ts`).
 * - A click or an Enter that may pay, order, send or submit waits for the person's button in
 *   Telegram (`browser-gate.ts`, `browser-approval.ts`). The gate is decided from the live page
 *   before the call and checked again inside it: a call that reaches execution gated without an
 *   approval of exactly this input is refused, so a page that changed meanwhile asks again.
 * - Typed data marks the browser session (not a search box); a new `open` clears the mark.
 * - `ctx.getSandbox()` first: it creates or resumes the session's container, the companion's
 *   parent, and moves any logged-in state out of the tool environment before Bash runs.
 * - The scope of screenshots comes from the chat's verified workspace mounts, never from input.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { SANDBOX_RUNNER_BASE_URL } from "../../config.js";
import { browserApprovalDecision, browserLabelMismatch, resolveBrowserGate } from "../browser/browser-approval.js";
import { BROWSER_ACTIONS, type BrowserAction, parseBrowserAction } from "../browser/browser-command.js";
import { sandboxBrowserPageReader } from "../browser/browser-page-reader.js";
import { browserEnteredData, isDataEntryTarget, parseSnapshotElements } from "../browser/browser-gate.js";
import { runBrowserAction } from "../browser/browser-session.js";
import { ModelFacingError } from "../model-facing-error.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";
import { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";
import { sandboxSessionId } from "../sessions/session-context.js";
import { requireInputRecord, toolInputError } from "../tool-input-validation.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { workspaceRepository } from "../workspaces/workspace-repository.js";

const INPUT_ERROR_CODE = "AGENT_BROWSER_INPUT_INVALID";
const runner = new SandboxRunnerClient(SANDBOX_RUNNER_BASE_URL);

const browserSchema = z.object({
  action: z.enum(BROWSER_ACTIONS).describe("Действие браузера"),
  direction: z.enum(["down", "up"]).optional().describe("Для scroll"),
  fullPage: z.boolean().optional().describe("Для screenshot: вся страница"),
  key: z.string().max(40).optional().describe("Для press: Enter, Tab, Escape, ArrowDown, Control+a"),
  label: z.string().max(300).optional().describe("Для click: точное имя элемента из snapshot"),
  milliseconds: z.number().int().optional().describe("Для wait: 100–10000"),
  ref: z.string().max(12).optional().describe("@eN из последнего snapshot"),
  text: z.string().max(4_000).optional().describe("Для fill, type, select"),
  url: z.string().max(2_048).optional().describe("Для open: полный http(s) адрес"),
});

const DESCRIPTION = [
  "Браузер Chrome этого чата: сохраняет вход на сайты между ходами, видит JavaScript, формы и кнопки.",
  "Для чтения открытой страницы сначала web_fetch; browser, когда нужен вход, клик, форма или снимок.",
  "Порядок: open, затем snapshot (элементы с ref вида @e12), затем click/fill/type/select/press по ref; после перехода снова snapshot. В click передавай label, точное имя элемента из snapshot.",
  "read даёт текст страницы или элемента, url и title адрес и заголовок, screenshot сохраняет снимок в shots/ рабочей папки (смотреть inspect_workspace_image, отправить send_workspace_file).",
  "Нажимаешь ты сама: на оплату, заказ, отправку и любой клик или Enter после ввода данных вызывай click с label, и приложение до нажатия само покажет человеку окно «подтвердить/отменить». Без твоего вызова click окна нет; не проси человека жать в чате и не заканчивай ход обещанием кнопки. Коды из SMS и пароли диктует человек.",
].join(" ");

/** The tool's own approval and its execution see the same browser session key. */
function browserSession(ctx: Parameters<typeof sandboxSessionId>[0]): string {
  return sandboxSessionId(ctx);
}

export default defineTool({
  approval: async ({ session, toolInput }) => {
    let action: BrowserAction;
    try {
      action = parseBrowserAction(requireInputRecord(toolInput, "browser", INPUT_ERROR_CODE));
    } catch {
      return "not-applicable";
    }
    const sessionId = browserSession({ session });
    return await browserApprovalDecision({
      action,
      entered: browserEnteredData.has(sessionId),
      page: sandboxBrowserPageReader(sessionId),
    });
  },
  description: DESCRIPTION,
  inputSchema: browserSchema,
  async execute(input, ctx) {
    const action = parseBrowserAction(requireInputRecord(input, "browser", INPUT_ERROR_CODE));
    const mounts = await workspaceRepository.mounts(requireWorkspaceAuthorization(ctx));
    const points = new Set(mounts.map((mount) => mount.mountPoint));
    const scope = points.has("personal") ? "personal" : points.has("family") ? "family" : null;
    if (!scope) toolInputError("AGENT_BROWSER_SCOPE_FORBIDDEN", "Браузер доступен только в личном чате и семейной группе");
    await ctx.getSandbox();
    const sessionId = browserSession(ctx);
    const page = sandboxBrowserPageReader(sessionId, ctx.abortSignal);

    if (action.action === "click" || action.action === "press") {
      const gate = await resolveBrowserGate({ action, entered: browserEnteredData.has(sessionId), page });
      const mismatch = browserLabelMismatch(action, gate);
      if (mismatch) {
        throw new ModelFacingError({
          category: "input", code: "AGENT_BROWSER_LABEL_REQUIRED", correction: mismatch.replace(/^[A-Z_]+: /u, ""),
          reason: "Имя элемента не совпало со страницей", retryable: true, sideEffectStatus: "not_started",
        });
      }
      if (gate.gated) {
        try {
          await requireToolApprovalEvidence(ctx, "browser", input);
        } catch {
          throw new ModelFacingError({
            category: "conflict", code: "AGENT_BROWSER_CONFIRMATION_REQUIRED",
            correction: "Страница изменилась с момента вызова. Сделай snapshot и повтори действие: человек получит кнопку подтверждения.",
            reason: "Это нажатие требует подтверждения человека", retryable: true, sideEffectStatus: "not_started",
          });
        }
      }
    }
    const typing = action.action === "fill" || action.action === "type" || action.action === "select";
    // Read before typing: after it the page may show another form under the same ref.
    const entryTarget = typing
      ? parseSnapshotElements(await page.snapshot().catch(() => "")).get(action.ref)
      : undefined;

    const result = await runBrowserAction({
      action,
      runner: {
        run: async (request) => await runner.run(sessionId, request, ctx.abortSignal),
        writeFile: async (path, content) => await runner.writeFile(sessionId, path, content, ctx.abortSignal),
      },
      scope,
    });
    if (action.action === "open") browserEnteredData.clear(sessionId);
    if (typing && isDataEntryTarget(entryTarget)) {
      browserEnteredData.mark(sessionId);
    }
    return result;
  },
});
