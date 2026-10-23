/**
 * `web_fetch` converts pages with linear code instead of turndown and tag-stripping regular expressions.
 *
 * Eve 0.40.0 converts a page to Markdown with turndown, which builds a DOM, recurses over it and trims whitespace
 * with regular expressions that restart at every space; its text mode strips tags with regular expressions that
 * restart at every `<`. Measured on this installation on 7 October 2026: a 4.8 MB page of `<b>x</b>` blocks the event
 * loop of the one agent process for 91 s, 100 000 nested `<div>` for 60 s, a plain 1.1 MB page for 3 s, unclosed
 * `<script ` for 14 s in text mode. The agent serves every family, so one page froze all chats.
 *
 * ilkruglov replaced them (commits b0cc2ea4 and the follow-ups of three Codex reviews, 5 October 2026) with one
 * linear pass cut at an output budget. The three sources stay in scripts/eve-runtime (typechecked, tested; the Docker dependency stage copies only scripts) and this patch copies
 * them, types stripped, next to Eve's `html.js`, which then delegates to them.
 */
import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";

const WEB_FETCH = resolve("node_modules/eve/dist/src/execution/web-fetch");

const HTML_JS = `import { htmlToMarkdown } from "./osinara-html-markdown.js";
import { htmlToText } from "./osinara-html-text.js";
// Osinara: one linear pass over the page, cut at an output budget (see scripts/eve-patches/web-fetch-html.ts).
function convertHtmlToMarkdown(t) {
  return htmlToMarkdown(t).markdown;
}
// Osinara: one linear pass instead of tag-stripping regular expressions that restart at every \`<\`.
function extractTextFromHtml(e) {
  return htmlToText(e);
}
export { convertHtmlToMarkdown, extractTextFromHtml };
`;

async function runtimeSource(name: string): Promise<string> {
  const source = await readFile(`scripts/eve-runtime/${name}.ts`, "utf8");
  return stripTypeScriptTypes(source)
    .replaceAll('"./html-entities.js"', '"./osinara-html-entities.js"')
    .replaceAll('"./html-text.js"', '"./osinara-html-text.js"');
}

export async function patchWebFetchHtml(): Promise<void> {
  const htmlPath = `${WEB_FETCH}/html.js`;
  const current = await readFile(htmlPath, "utf8");
  if (!current.includes("osinara-html-markdown.js") && !current.includes('import TurndownService from"#compiled/turndown/index.js"')) {
    throw new Error("AGENT_EVE_PATCH_ANCHOR_MISSING: web-fetch html.js is neither the reviewed Eve 0.40.0 file nor patched");
  }
  for (const name of ["html-entities", "html-markdown", "html-text"]) {
    await writeFile(`${WEB_FETCH}/osinara-${name}.js`, await runtimeSource(name), "utf8");
  }
  await writeFile(htmlPath, HTML_JS, "utf8");
}
