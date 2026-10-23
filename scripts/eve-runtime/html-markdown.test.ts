/**
 * Linear HTML to Markdown.
 *
 * Constructs covered:
 * - Headings, paragraphs, line breaks, rules, nested lists (paragraphs, line breaks, links, code
 *   and fenced blocks stay in their item at the content column of its marker, indentation
 *   capped), quotes (prefix capped, also on fenced blocks), table rows (blocks inside a cell stay
 *   in its row, a <pre> there becomes inline code), emphasis.
 * - Code: <pre> keeps blank lines and trailing spaces and drops only a line break right after its
 *   start tag; links inside keep the code's text; fences and inline delimiters are longer than
 *   any backtick run inside.
 * - Links: edge spaces kept outside the label, an unclosed link still gets its address, a new
 *   link closes an open one, a link around blocks keeps them, a code span or block at the link's
 *   start does not take its address, brackets of the label text are escaped; `javascript:`
 *   (with controls or entities inside the scheme), `vbscript:` and `data:` give no address; `)`
 *   and spaces are percent-encoded, non-ASCII spaces as UTF-8; a `>` in another attribute or a
 *   quote inside an unquoted value does not lose the link.
 * - The output never passes the budget, and a cut is reported, including a cut inside one text
 *   node.
 * - Codex reviews (5 October 2026): shapes that were quadratic stay linear.
 */
import { describe, expect, it } from "vitest";

import { htmlToMarkdown } from "./html-markdown.js";

const markdown = (html: string) => htmlToMarkdown(html).markdown;

describe("htmlToMarkdown", () => {
  it("converts headings, paragraphs, emphasis, links and lists", () => {
    expect(markdown("<h1>Title</h1><p>Some <b>bold</b>, <em>it</em> and <a href=\"https://e.x/a?x=1&amp;y=2\">link</a>.</p><ul><li>one</li><li>two</li></ul>"))
      .toBe("# Title\n\nSome **bold**, *it* and [link](https://e.x/a?x=1&y=2).\n\n- one\n- two");
    expect(markdown("<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>")).toBe("1. a\n   - b\n2. c");
    expect(markdown("a<br>b<hr>c<div>d</div>e<span>f</span>g")).toBe("a\nb\n\n---\n\nc\n\nd\n\nefg");
    expect(markdown("<p>&eacute;t&eacute; &mdash; ok</p>")).toBe("été — ok");
  });

  it("keeps paragraphs and line breaks inside their list item and blocks inside their cell", () => {
    expect(markdown("<ul><li><p>A</p><p>B</p></li><li>C</li></ul>")).toBe("- A\n\n  B\n\n- C");
    expect(markdown("<ul><li>line one<br>line two</li></ul>")).toBe("- line one\n  line two");
    // Continuation lines start at the item's content column, which depends on the marker's width.
    expect(markdown("<ol><li><p>A</p><p>B</p></li><li>C</li></ol>")).toBe("1. A\n\n   B\n\n2. C");
    expect(markdown("<ul><li><p>A</p><p><a href=/b>B</a> and <code>c</code></p></li></ul>")).toBe("- A\n\n  [B](/b) and `c`");
    expect(markdown("<blockquote><p><a href=/b>B</a></p></blockquote>")).toBe("> [B](/b)");
    expect(markdown("<table><tr><td><p>A</p></td><td><p>B</p></td></tr><tr><td>1</td><td>2</td></tr></table>"))
      .toBe("A | B\n1 | 2");
  });

  it("keeps preformatted text exactly and picks delimiters longer than the code's backticks", () => {
    expect(markdown("<pre><code>a\n\n\n\nb  \n</code></pre><p>x <code>y</code></p>")).toBe("```\na\n\n\n\nb  \n```\n\nx `y`");
    expect(markdown("<pre>use ```js fences```</pre>")).toBe("````\nuse ```js fences```\n````");
    expect(markdown("<p><code>a`b</code> and <code>`x`</code></p>")).toBe("``a`b`` and `` `x` ``");
    expect(markdown("<blockquote><p>quoted</p></blockquote>after")).toBe("> quoted\n\nafter");
    // Only a line break right after <pre> is dropped, as in a browser.
    expect(markdown("<pre>\nX</pre>")).toBe("```\nX\n```");
    expect(markdown("<pre><code>\nX</code></pre>")).toBe("```\n\nX\n```");
    // Links inside code keep the code's text.
    expect(markdown("<pre><code><a href=\"/x\">foo</a>\nbar</code></pre>")).toBe("```\nfoo\nbar\n```");
  });

  it("keeps a fenced block inside its list item, quote or table row", () => {
    expect(markdown("<ul><li><p>Install</p><pre>npm install x</pre></li></ul>")).toBe("- Install\n\n  ```\n  npm install x\n  ```");
    expect(markdown("<blockquote><pre>a\n\nb</pre></blockquote>")).toBe("> ```\n> a\n>\n> b\n> ```");
    expect(markdown("<table><tr><td><pre>x\ny</pre></td><td>B</td></tr></table>")).toBe("` x y ` | B");
  });

  it("keeps link edges, closes unclosed and overlapping links and keeps blocks inside links", () => {
    expect(markdown("<a href=\"/x\"> foo </a>bar")).toBe("[foo](/x) bar");
    expect(markdown("<p>see <a href=\"/r\">unclosed")).toBe("see [unclosed](/r)");
    expect(markdown("<a href=\"/a\">x <a href=\"/b\">y</a> z")).toBe("[x](/a) [y](/b) z");
    expect(markdown("<a href=\"/x\"><h2>B</h2><p>C</p></a>")).toBe("## B\n\nC (/x)");
    expect(markdown("<a title=\"a > b\" href=\"/r\">link</a><p>TAIL</p>")).toBe("[link](/r)\n\nTAIL");
    expect(markdown("<a href=\"/r\"><img src=a.png alt=A></a>")).toBe("[![A](a.png)](/r)");
    // A code span or block opening at the same place as its link does not take the link's address.
    expect(markdown("<a href=\"/api\"><code>foo()</code></a>")).toBe("[`foo()`](/api)");
    expect(markdown("<a href=\"/api\"><pre>foo</pre></a>")).toBe("```\nfoo\n``` (/api)");
    expect(markdown("<a href=\"/x\">a]b [c]</a>")).toBe("[a\\]b \\[c\\]](/x)");
    expect(markdown("<p>before</p><a href=/x?foo='>LINK</a><p>after</p>")).toBe("before\n\n[LINK](/x?foo=')\n\nafter");
  });

  it("drops script and inline-data addresses and encodes characters that end a link target", () => {
    expect(markdown("<a href=\" JavaScript:x\">a</a> <a href=\"java&#10;&#10;&#10;script:x\">b</a> <a href=\"&#1;vbscript:x\">c</a>"))
      .toBe("a b c");
    expect(markdown("<img src=\"data:image/png;base64,AA\" alt=\"inline\">")).toBe("inline");
    expect(markdown("<a href=\"/a b)(c\">t</a>")).toBe("[t](/a%20b%29%28c)");
    expect(markdown("<a href=\"https://e.x/a\u2003b\">t</a>")).toBe("[t](https://e.x/a%E2%80%83b)");
    expect(markdown("<img\nsrc=/i.png alt='pic &amp; co'>")).toBe("![pic & co](/i.png)");
  });

  it("drops scripts, styles, SVG and comments and keeps CDATA as text", () => {
    expect(markdown("<h1>T</h1><script>x<p></script><svg><text>s</text></svg><!-- c --><p>B <![CDATA[<i>raw</i>]]></p>"))
      .toBe("# T\n\nB <i>raw</i>");
  });

  it("caps nesting markers and the list stack", () => {
    const nested = markdown("<ul><li>".repeat(50) + "deep" + "</li></ul>".repeat(50));
    expect(nested.split("\n").at(-1)).toBe(`${" ".repeat(24)}- deep`);
    expect(markdown("<blockquote>".repeat(20) + "q")).toBe(`${"> ".repeat(4)}q`);
    expect(markdown("<ul>".repeat(1_000) + "<li>x" + "</ul>".repeat(1_000) + "<p>after</p>")).toMatch(/- x\n\nafter$/u);
  });

  it("never passes the budget and reports every cut", () => {
    expect(htmlToMarkdown("<p>abcdef</p>".repeat(10), 20)).toEqual({ markdown: "abcdef\n\nabcdef\n\nabcd", truncated: true });
    expect(htmlToMarkdown("x".repeat(5 * 1024 * 1024), 1_000)).toEqual({ markdown: "x".repeat(1_000), truncated: true });
    expect(htmlToMarkdown("<a href=\"/long\">" + "y".repeat(50) + "</a>", 30).markdown.length).toBeLessThanOrEqual(30);
    expect(htmlToMarkdown("<p>abc</p>", 20)).toEqual({ markdown: "abc", truncated: false });
  });

  it.each([
    ["empty links after line breaks in pre", "<pre>" + "\n".repeat(80_000) + "<a></a>".repeat(40_000) + "TAIL</pre>"],
    ["empty code spans after spaces", "<p>" + " ".repeat(80_000) + "<code></code>".repeat(40_000) + "TAIL</p>"],
    ["empty links after a long word", "x".repeat(80_000) + "<a href=/x></a>".repeat(40_000) + "TAIL"],
    ["spaces before many breaks", ("word" + " ".repeat(30) + "<br>").repeat(20_000) + "TAIL"],
    ["a million list openers", "<ul>".repeat(1_000_000) + "TAIL"],
  ])("converts %s in linear time", (_name, html) => {
    const started = performance.now();
    const { markdown: result, truncated } = htmlToMarkdown(html);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(truncated).toBe(false);
    expect(result.endsWith("TAIL") || result.endsWith("TAIL\n```")).toBe(true);
  });
});
