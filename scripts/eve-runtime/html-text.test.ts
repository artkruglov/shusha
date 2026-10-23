/**
 * Linear HTML scanning.
 *
 * Constructs covered:
 * - Visible text with block ends as line breaks and inline elements joined to their neighbours;
 *   script, style, template and noscript content, comments and declarations are dropped; CDATA
 *   keeps its text; custom elements with `-` are not mistaken for skipped ones; a self-closing
 *   skipped element hides nothing; entities decode, invalid numeric ones stay as written.
 * - A `>` inside a quoted attribute value does not end the tag; a tag still open at the end of the
 *   page hides the rest, as in a browser.
 * - Every named HTML entity decodes, case-sensitively; prototype names are not entities.
 * - Adversarial markup is handled in linear time by both conversions (html-markdown.test.ts
 *   covers the Markdown output).
 */
import { describe, expect, it } from "vitest";

import { htmlToMarkdown } from "./html-markdown.js";
import { decodeHtmlEntities, htmlToText } from "./html-text.js";

describe("htmlToText", () => {
  it("keeps visible text, breaks lines at block ends and joins inline elements", () => {
    expect(htmlToText("<article><h1>Title</h1><p>Body &amp; more</p></article>")).toBe("Title\nBody & more");
    expect(htmlToText("a<br>b<BR/>c")).toBe("a\nb\nc");
    expect(htmlToText("<p>one</p>\n\n\n\n<p>two</p>")).toBe("one\n\ntwo");
    expect(htmlToText("x<b>y</b>z <a href=\"/u\">link</a>s")).toBe("xyz links");
    expect(htmlToText("cell<td>next")).toBe("cell next");
  });

  it("drops scripts, styles, templates, comments and declarations and keeps CDATA text", () => {
    expect(htmlToText("x<script type=\"a\">var a = '<p>';</script>y<style>p{}</STYLE >z<!-- c -->w"))
      .toBe("x y z w");
    expect(htmlToText("<!DOCTYPE html><?xml version=\"1.0\"?>before<template><p>hidden</p></template>after"))
      .toBe("before after");
    expect(htmlToText("a<![CDATA[raw <text>]]>b")).toBe("araw <text>b");
  });

  it("keeps the content of custom elements and of self-closing foreign elements", () => {
    expect(htmlToText("<script-widget>visible</script-widget><p>after</p>")).toBe("visible after");
    expect(htmlToText("<svg/><p>after</p>")).toBe("after");
    // `/>` does not close a script in HTML: a browser runs everything after it as the script.
    expect(htmlToText("before<script/><p>hidden</p>")).toBe("before");
  });

  it("ends a tag only outside quoted attribute values", () => {
    expect(htmlToText("<a title=\"a > b\" href=\"/r\">link</a> after")).toBe("link after");
    expect(htmlToText("x<p data-x='>'>y</p>")).toBe("x y");
    // `=` before any attribute name starts a name, and its quote is part of that name.
    expect(htmlToText("before<a ='>VISIBLE</a><p>TAIL</p>")).toBe("beforeVISIBLE TAIL");
    // A quote inside an unquoted value is part of it and opens nothing.
    expect(htmlToText("<p>before</p><a href=/x?foo='>LINK</a><p>after</p>")).toBe("before\nLINK after");
    // A tag open at the end of the page (here an unclosed quote) hides the rest, as in a browser.
    expect(htmlToText("before<a title=\"never closed>after")).toBe("before");
  });

  it("ends comments, skipped elements and tag names the way a browser does", () => {
    expect(htmlToText("before<!-->VISIBLE<p>TAIL</p>")).toBe("before VISIBLE TAIL");
    expect(htmlToText("before<!--->VISIBLE<p>TAIL</p>")).toBe("before VISIBLE TAIL");
    expect(htmlToText("before<!-- x --!>VISIBLE<p>TAIL</p>")).toBe("before VISIBLE TAIL");
    expect(htmlToText("before<script>x</script foo><p>TAIL</p>")).toBe("before TAIL");
    expect(htmlToText("before<script>x</script/><p>TAIL</p>")).toBe("before TAIL");
    expect(htmlToText("before<script@x>VISIBLE<p>TAIL</p>")).toBe("before VISIBLE TAIL");
    // Text-only elements hold no markup: a <script> inside a textarea is its text.
    expect(htmlToText("before<textarea><script>VISIBLE</textarea><p>TAIL</p>")).toBe("before <script>VISIBLE TAIL");
  });

  it("treats a lone < as text and drops what an unterminated comment or script hides", () => {
    expect(htmlToText("1 < 2 and 3 > 2")).toBe("1 < 2 and 3 > 2");
    expect(htmlToText("a <!-- never closed <p>b</p>")).toBe("a");
    expect(htmlToText("a <script>while(true){}")).toBe("a");
  });

  it("decodes entities and leaves invalid ones as written", () => {
    expect(decodeHtmlEntities("&lt;b&gt; &#1055;&#x438; &quot;x&quot; &unknown;")).toBe("<b> Пи \"x\" &unknown;");
    expect(decodeHtmlEntities("&#0; &#9999999; &#x110000;")).toBe("&#0; &#9999999; &#x110000;");
    expect(decodeHtmlEntities("&eacute; &Eacute; &copy; &mdash; &NotEqualTilde; &CounterClockwiseContourIntegral; &#X41;"))
      .toBe("é É © — \u2242\u0338 \u2233 A");
    expect(decodeHtmlEntities("&constructor; &toString; &EACUTE;")).toBe("&constructor; &toString; &EACUTE;");
  });

  it.each([
    ["runs of < without >", "<".repeat(1_048_576)],
    ["< followed by letters without >", "<a".repeat(524_288)],
    ["lone < before a far >", "< ".repeat(524_287) + ">"],
    ["unterminated comments", "<!--".repeat(262_144)],
    ["unterminated declarations", "<!x".repeat(349_525)],
    ["script openers without end tags", "<script>".repeat(131_072)],
    ["many tags", "<p>x</p>".repeat(131_072)],
    ["entities without semicolons", "&aaaaaaaaaaa".repeat(87_381)],
    ["long entity-like names", ("&" + "a".repeat(40)).repeat(25_000)],
    ["tags with unclosed quotes", "<a x=\"".repeat(200_000)],
    ["tags with many quoted values", "<a" + " x=\">\"".repeat(150_000) + ">"],
    ["comments without an end", "<!-- a ".repeat(150_000)],
    // Codex security scan of 1.8.27: each comment searched for `-->` to the end of the page anew.
    ["comments closed only by --!>", "<!--x--!>".repeat(116_508)],
    ["empty comments", "<!---->".repeat(150_000)],
    ["unclosed textareas", "<textarea>".repeat(100_000)],
  ])("handles a megabyte of %s in linear time", (_name, html) => {
    const started = performance.now();
    htmlToText(html);
    htmlToMarkdown(html);
    // The regex version took over a second for 64 KiB of `<`; a linear pass over a megabyte
    // is tens of milliseconds even on a slow core.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
