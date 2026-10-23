/**
 * Linear HTML to Markdown for pages that web_fetch hands to the model.
 *
 * Exports:
 * - `htmlToMarkdown`: headings, paragraphs, lists, quotes, fenced and inline code, emphasis,
 *   links, images and table rows from one pass over the page, cut at an output budget with a
 *   flag telling whether it was cut.
 * - `MARKDOWN_MAX_OUTPUT_CHARACTERS`: that budget by default.
 *
 * Key construct:
 * - Markdown used to come from the vendored turndown, which builds a DOM, recurses over it and
 *   trims whitespace with regular expressions that restart at every space of a run: three Codex
 *   reviews (5 October 2026) kept finding pages inside any input budget that blocked the event
 *   loop for 9-19 s or overflowed its stack. Here the tokenizer of html-text.ts feeds a writer
 *   that keeps its state per written part, so nothing written is read again except once, when a
 *   link, a code span or a <pre> is closed and its content wrapped. No tree, no recursion, no
 *   regular expression that can backtrack.
 * - The writer holds the budget itself: no write passes it, and a cut sets `truncated`.
 */
import { decodeHtmlEntities, INLINE_ELEMENTS, MARKDOWN_SKIPPED_ELEMENTS, tokens } from "./html-text.js";

// The model sees at most 50 KB of Markdown; the conversion stops well past that.
export const MARKDOWN_MAX_OUTPUT_CHARACTERS = 500_000;
// Shortened attribute values: a link or image keeps what the model needs to follow or name it.
const MARKDOWN_MAX_URL = 2_000;
const MARKDOWN_MAX_ALT = 300;
// Nesting is capped: indentation and quote prefixes repeat on every line, and the list stack
// must not grow with a page of a million `<ul>`. Indentation stops at 8 levels of 3 columns.
const MAX_LIST_INDENT = 8;
const MAX_QUOTE_PREFIX = 4;
const MAX_TRACKED_LISTS = 32;
const HEADINGS: Readonly<Record<string, number>> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const BLOCKS = new Set([
  "address", "article", "aside", "details", "div", "dl", "fieldset", "figcaption", "figure",
  "footer", "form", "header", "main", "nav", "p", "section", "summary", "table",
]);
const STRONG = new Set(["b", "strong"]);
const EMPHASIS = new Set(["cite", "dfn", "em", "i"]);

/** One attribute's value from a raw start tag, read in a single forward scan. */
function attribute(raw: string, wanted: string): string | null {
  // Past `<` and the element name.
  let index = 1;
  while (index < raw.length && !/[\s/>]/u.test(raw[index]!)) index += 1;
  while (index < raw.length) {
    while (index < raw.length && /[\s/]/u.test(raw[index]!)) index += 1;
    if (index >= raw.length || raw[index] === ">") return null;
    const nameStart = index;
    while (index < raw.length && !/[\s=/>]/u.test(raw[index]!)) index += 1;
    const name = raw.slice(nameStart, index).toLowerCase();
    while (index < raw.length && /\s/u.test(raw[index]!)) index += 1;
    let value = "";
    if (raw[index] === "=") {
      index += 1;
      while (index < raw.length && /\s/u.test(raw[index]!)) index += 1;
      const quote = raw[index];
      if (quote === "\"" || quote === "'") {
        const end = raw.indexOf(quote, index + 1);
        const stop = end === -1 ? raw.length : end;
        value = raw.slice(index + 1, stop);
        index = stop + 1;
      } else {
        const valueStart = index;
        while (index < raw.length && !/[\s>]/u.test(raw[index]!)) index += 1;
        value = raw.slice(valueStart, index);
      }
    }
    if (name === wanted) return value;
  }
  return null;
}

/**
 * An attribute URL as a Markdown link target: entities decoded, whitespace and the characters
 * that end or open a link target percent-encoded (UTF-8 bytes for non-ASCII spaces), cut to a
 * length. Script and inline-data schemes give nothing; the scheme is read the way a browser
 * reads it, with tabs and line breaks removed and leading controls skipped.
 */
function markdownUrl(raw: string | null): string {
  const url = decodeHtmlEntities(raw ?? "").trim().slice(0, MARKDOWN_MAX_URL);
  // oxlint-disable-next-line no-control-regex -- leading C0 controls are skipped by browsers.
  const scheme = url.replace(/[\t\n\r]/gu, "").replace(/^[\u0000- ]+/u, "").slice(0, 16).toLowerCase();
  if (/^(?:javascript|vbscript|data):/u.test(scheme)) return "";
  return url.replace(/[\s()<>[\]]/gu, (character) => {
    const code = character.charCodeAt(0);
    return code < 0x80 ? `%${code.toString(16).toUpperCase().padStart(2, "0")}` : encodeURIComponent(character);
  });
}

/** Text as one line: whitespace runs become one space (a single character class, no backtracking). */
function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\n\r\f]+/gu, " ");
}

/** A delimiter of backticks longer than any run of backticks inside `text`. */
function backtickFence(text: string, minimum: number): string {
  let longest = 0;
  let run = 0;
  for (let index = 0; index < text.length; index += 1) {
    run = text.charCodeAt(index) === 0x60 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return "`".repeat(Math.max(minimum, longest + 1));
}

/**
 * The output as parts, with the count of line breaks ending the output after each part, so
 * taking parts back restores the state without reading them again.
 */
class MarkdownWriter {
  private readonly parts: string[] = [];
  private readonly newlinesAfter: number[] = [];
  private readonly marks: number[] = [];
  length = 0;
  truncated = false;
  /** Inside <pre>: line ends keep their spaces. */
  preserve = false;

  private readonly maxCharacters: number;

  constructor(maxCharacters: number) {
    this.maxCharacters = maxCharacters;
  }

  private get trailingNewlines(): number {
    return this.newlinesAfter.at(-1) ?? 0;
  }

  get atLineStart(): boolean {
    return this.parts.length === 0 || this.trailingNewlines > 0;
  }

  get endsWithSpace(): boolean {
    const last = this.parts.at(-1);
    return last !== undefined && last.charCodeAt(last.length - 1) === 0x20;
  }

  write(text: string): void {
    if (text === "") return;
    let piece = text;
    const room = this.maxCharacters - this.length;
    if (piece.length > room) {
      this.truncated = true;
      let cut = Math.max(0, room);
      // A cut between the halves of a surrogate pair would leave half a character.
      const before = piece.charCodeAt(cut - 1);
      if (cut > 0 && before >= 0xd800 && before <= 0xdbff) cut -= 1;
      piece = piece.slice(0, cut);
      if (piece === "") return;
    }
    let index = piece.length;
    while (index > 0 && piece.charCodeAt(index - 1) === 0x0a) index -= 1;
    this.newlinesAfter.push(index === 0 ? this.trailingNewlines + piece.length : piece.length - index);
    this.parts.push(piece);
    this.length += piece.length;
  }

  /** Spaces ending the last line go; parts before the innermost open mark are not touched. */
  private trimLineEnd(): void {
    const floor = this.marks.at(-1) ?? 0;
    while (this.parts.length > floor) {
      const last = this.parts.at(-1)!;
      let index = last.length;
      while (index > 0 && last.charCodeAt(index - 1) === 0x20) index -= 1;
      if (index === last.length) return;
      this.parts.pop();
      this.newlinesAfter.pop();
      this.length -= last.length;
      // A part is trimmed once: what is left ends without a space.
      if (index > 0) {
        this.write(last.slice(0, index));
        return;
      }
    }
  }

  /** Ends the current line and leaves `count` line breaks (2 for a paragraph break). */
  breakLines(count: number): void {
    if (!this.preserve) this.trimLineEnd();
    if (this.parts.length === 0) return;
    if (this.trailingNewlines < count) this.write("\n".repeat(count - this.trailingNewlines));
  }

  /**
   * Starts a span whose content `take` returns, to be written again wrapped. The handle is the
   * span's place in the stack of open spans, so spans opened at the same output position still
   * know which one is inside the other.
   */
  open(): number {
    this.marks.push(this.parts.length);
    return this.marks.length - 1;
  }

  /** Everything written since the span opened, taken out of the output; spans inside it end too. */
  take(handle: number): string {
    const mark = this.marks[handle] ?? this.parts.length;
    this.marks.length = Math.min(this.marks.length, handle);
    const taken = this.parts.splice(mark).join("");
    this.newlinesAfter.splice(mark);
    this.length -= taken.length;
    return taken;
  }

  result(): string {
    return this.parts.join("").trim();
  }
}

interface Span { handle: number }
interface LinkSpan extends Span { href: string; inPre: boolean }
interface OpenList { ordered: boolean; count: number; content: number }

export function htmlToMarkdown(
  html: string,
  maxOutputCharacters: number = MARKDOWN_MAX_OUTPUT_CHARACTERS,
): { markdown: string; truncated: boolean } {
  const out = new MarkdownWriter(maxOutputCharacters);
  // Each open list knows the column its items' content starts at (marker column plus marker
  // width: `- ` is 2, `10. ` is 4), so continuation lines stay inside the item.
  const lists: OpenList[] = [];
  let untrackedLists = 0;
  let quoteDepth = 0;
  let preDepth = 0;
  let preFresh = false;
  let pre: Span | null = null;
  let link: LinkSpan | null = null;
  let code: Span | null = null;
  let cellIndex = 0;
  let inCell = false;
  // A list item whose marker is written and whose text is not: a block opening inside it stays on
  // the marker's line (`<li><p>A</p>` is `- A`).
  let freshItem = false;

  const quotePrefix = () => "> ".repeat(Math.min(quoteDepth, MAX_QUOTE_PREFIX));
  const contentColumn = () => lists.at(-1)?.content ?? 0;
  const continuation = () => quotePrefix() + " ".repeat(contentColumn());
  const space = () => {
    if (!out.atLineStart && !out.endsWithSpace) out.write(" ");
  };
  const block = () => {
    if (freshItem) return;
    if (inCell) space();
    else out.breakLines(preDepth > 0 ? 1 : 2);
  };
  // The container prefix (quote, list indentation) goes before anything at a line start, and
  // outside a span about to open, so taking the span back never takes the prefix with it.
  const startLine = () => {
    if (out.atLineStart && preDepth === 0) out.write(continuation());
  };
  const writeText = (text: string) => {
    startLine();
    out.write(text);
    freshItem = false;
  };
  // Text with line breaks (a link around blocks) keeps its blocks and gets the address after it;
  // a link inside <pre> keeps the code's text as it is.
  const closeLink = (span: LinkSpan) => {
    if (code !== null && code.handle > span.handle) code = null;
    const taken = out.take(span.handle);
    const text = taken.trim();
    if (span.href === "" || text === "" || span.inPre) {
      out.write(taken);
      return;
    }
    if (taken.startsWith(" ")) out.write(" ");
    out.write(text.includes("\n") ? `${text} (${span.href})` : `[${text}](${span.href})`);
    if (taken.endsWith(" ")) out.write(" ");
  };
  const closeCode = (span: Span) => {
    if (link !== null && link.handle > span.handle) link = null;
    const taken = out.take(span.handle);
    const text = taken.trim();
    if (text === "") {
      out.write(taken);
      return;
    }
    const fence = backtickFence(text, 1);
    const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
    if (taken.startsWith(" ")) out.write(" ");
    out.write(`${fence}${pad}${text}${pad}${fence}`);
    if (taken.endsWith(" ")) out.write(" ");
  };
  // A fenced block inside a list item or quote carries the container prefix on every line; in a
  // table cell it becomes inline code, so the row stays one line.
  const closePre = (span: Span) => {
    if (link !== null && link.handle > span.handle) link = null;
    const content = out.take(span.handle);
    out.preserve = false;
    if (inCell) {
      const text = collapseWhitespace(content).trim();
      if (text !== "") {
        const fence = backtickFence(text, 1);
        space();
        out.write(`${fence} ${text} ${fence}`);
      }
      return;
    }
    const fence = backtickFence(content, 3);
    const prefix = continuation();
    const lines = `${fence}\n${content}${content.endsWith("\n") || content === "" ? "" : "\n"}${fence}`.split("\n");
    out.write(lines.map((line, index) => (index === 0 && !out.atLineStart ? "" : line === "" ? prefix.trimEnd() : prefix) + line).join("\n"));
    freshItem = false;
    out.breakLines(2);
  };

  for (const token of tokens(html, MARKDOWN_SKIPPED_ELEMENTS)) {
    if (out.truncated) break;
    // Only a line break right after <pre> is not content, as in a browser.
    const atPreStart = preFresh;
    preFresh = false;
    if (token.kind === "skip") {
      // A dropped script or comment still separates the words around it.
      if (preDepth === 0) space();
      continue;
    }
    if (token.kind === "text") {
      const decoded = token.cdata ? token.text : decodeHtmlEntities(token.text);
      if (preDepth > 0) {
        out.write(atPreStart ? decoded.replace(/^\r?\n/u, "") : decoded);
        continue;
      }
      let text = collapseWhitespace(decoded);
      if (out.atLineStart || out.endsWithSpace) text = text.trimStart();
      // Brackets of the page's own text would end the link label early; generated markup inside
      // the label (an image, a code span) is not text and stays as it is.
      if (link !== null && code === null) text = text.replace(/[[\]]/gu, "\\$&");
      if (text !== "") writeText(text);
      continue;
    }
    const { closing, name } = token;
    const heading = HEADINGS[name];
    if (heading !== undefined) {
      block();
      if (!closing && !inCell) writeText(`${"#".repeat(heading)} `);
    } else if (name === "table") {
      inCell = false;
      block();
    } else if (BLOCKS.has(name)) {
      block();
    } else if (name === "blockquote") {
      quoteDepth = Math.max(0, quoteDepth + (closing ? -1 : 1));
      block();
    } else if (name === "ul" || name === "ol") {
      if (closing) {
        if (untrackedLists > 0) untrackedLists -= 1;
        else lists.pop();
      } else if (lists.length < MAX_TRACKED_LISTS) {
        const column = contentColumn();
        lists.push({ content: column, count: 0, ordered: name === "ol" });
      } else untrackedLists += 1;
      freshItem = false;
      if (inCell) space();
      else if (lists.length === 0) out.breakLines(2);
      else out.breakLines(1);
    } else if (name === "li" && !closing) {
      if (inCell) {
        space();
        continue;
      }
      out.breakLines(1);
      const list = lists.at(-1);
      // The items of a list sit at the content column of the item around the list.
      const column = Math.min(lists.at(-2)?.content ?? 0, MAX_LIST_INDENT * 3);
      const marker = list?.ordered && untrackedLists === 0 ? `${(list.count += 1)}. ` : "- ";
      out.write(`${quotePrefix()}${" ".repeat(column)}${marker}`);
      if (list !== undefined && untrackedLists === 0) list.content = column + marker.length;
      freshItem = true;
    } else if (name === "br") {
      if (preDepth > 0) out.write("\n");
      else if (inCell) space();
      else {
        freshItem = false;
        out.breakLines(1);
      }
    } else if (name === "hr") {
      block();
      if (!inCell) writeText("---");
      block();
    } else if (name === "pre") {
      if (!closing) {
        if (preDepth === 0) {
          block();
          startLine();
          pre = { handle: out.open() };
          out.preserve = true;
          preFresh = true;
        }
        preDepth += 1;
      } else if (preDepth > 0) {
        preDepth -= 1;
        if (preDepth === 0 && pre !== null) {
          closePre(pre);
          pre = null;
        }
      }
    } else if (name === "code" && preDepth === 0) {
      if (!closing && code === null) {
        startLine();
        code = { handle: out.open() };
      } else if (closing && code !== null) {
        closeCode(code);
        code = null;
      }
    } else if (STRONG.has(name) && preDepth === 0) {
      writeText("**");
    } else if (EMPHASIS.has(name) && preDepth === 0) {
      writeText("*");
    } else if (name === "a") {
      // A new link closes an open one, as in a browser; links never nest.
      if (link !== null) {
        closeLink(link);
        link = null;
      }
      if (!closing) {
        startLine();
        link = { handle: out.open(), href: markdownUrl(attribute(token.raw, "href")), inPre: preDepth > 0 };
      }
    } else if (name === "img" && !closing) {
      const src = markdownUrl(attribute(token.raw, "src"));
      const alt = collapseWhitespace(decodeHtmlEntities(attribute(token.raw, "alt") ?? "")).trim().slice(0, MARKDOWN_MAX_ALT);
      if (preDepth > 0) out.write(alt);
      else if (src !== "") writeText(`![${alt}](${src})`);
      else if (alt !== "") writeText(alt);
    } else if (name === "tr") {
      inCell = false;
      out.breakLines(1);
      cellIndex = 0;
    } else if (name === "td" || name === "th") {
      inCell = !closing;
      if (!closing) {
        if (cellIndex > 0) out.write(out.endsWithSpace ? "| " : " | ");
        cellIndex += 1;
      }
    } else if (!INLINE_ELEMENTS.has(name) && preDepth === 0) {
      // An unknown element separates words as a browser's block would; inline ones join them.
      space();
    }
  }
  // Spans still open at the end of the page (or of the budget) close from the innermost out;
  // closing one can end a span opened inside it, so each closer checks its span is still open.
  const open: Array<[Span, () => void]> = [];
  if (code !== null) open.push([code, () => code !== null && closeCode(code)]);
  if (link !== null) open.push([link, () => link !== null && closeLink(link)]);
  if (pre !== null) open.push([pre, () => pre !== null && closePre(pre)]);
  for (const [, close] of open.sort(([a], [b]) => b.handle - a.handle)) close();
  return { markdown: out.result(), truncated: out.truncated };
}
