/**
 * Pages built to stall a converter (measured on turndown and Eve's tag-stripping regular expressions on 7 October 2026:
 * 91 s for 4.8 MB of `<b>x</b>`, 60 s for 100 000 nested `<div>`, 14 s for unclosed `<script ` in text mode). The agent
 * is one process for every family, so each of them must finish in a fraction of a second.
 */
import { describe, expect, it } from "vitest";

import { htmlToMarkdown } from "./html-markdown.js";
import { htmlToText } from "./html-text.js";

const BUDGET_MS = 1_500;

const pages: Array<[string, string]> = [
  ["4.8 MB of inline tags", "<b>x</b>".repeat(600_000)],
  ["100 000 nested divs", "<div>".repeat(100_000) + "x"],
  ["5 000 nested list items", "<ul><li>".repeat(5_000) + "x"],
  ["50 000 unclosed script tags", "<script ".repeat(50_000)],
  ["50 000 script blocks without end", "<script>a".repeat(50_000)],
  ["a page of `<` without `>`", "<".repeat(2_000_000)],
  ["a 3 000 row table", "<table>" + ("<tr>" + "<td>c</td>".repeat(30) + "</tr>").repeat(3_000) + "</table>"],
];

describe("pathological pages", () => {
  it.each(pages)("converts %s to Markdown within the budget", (_name, html) => {
    const started = performance.now();
    const result = htmlToMarkdown(html);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    expect(result.markdown.length).toBeLessThanOrEqual(500_000);
  });

  it.each(pages)("converts %s to text within the budget", (_name, html) => {
    const started = performance.now();
    htmlToText(html);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});
