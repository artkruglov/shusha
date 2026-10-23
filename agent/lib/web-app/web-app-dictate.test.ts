/**
 * «Надиктовать» в Mini App (`infra/public/app/dictate.js`), прогнанный в песочнице `vm` с заглушками страницы.
 *
 * Проверяется (ревью 23 октября 2026): окно, закрытое, пока телефон спрашивал микрофон, не начинает запись и сразу
 * отпускает данный микрофон; строки сверх двадцати за раз не теряются, а остаются в окне для следующего нажатия.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

class FakeNode {
  value = "";
  children: FakeNode[] = [];
  events: Record<string, () => unknown> = {};
  classList = { add() {}, remove() {}, toggle() {} };
  constructor(readonly tag = "", readonly className = "", public textContent = "") {}
  append(...children: FakeNode[]) { this.children.push(...children); }
  replaceChildren(...children: FakeNode[]) { this.children = children; }
  setAttribute() {}
  focus() {}
  addEventListener(name: string, handler: () => unknown) { this.events[name] = handler; }
}

function dictation() {
  const nodes: FakeNode[] = [];
  const posts: string[] = [];
  let main: { onClick: () => Promise<void>; text: string } | null = null;
  let grant: (stream: unknown) => void = () => {};
  let closed = false;
  let close: () => void = () => {};
  let recordings = 0;
  let released = 0;
  const node = (tag: string, className: string, text = "") => {
    const made = new FakeNode(tag, className, text);
    nodes.push(made);
    return made;
  };
  const FA = {
    TASKS: ["дело", "дела", "дел"],
    board: { invalidate() {} },
    button: (className: string, text: string) => node("button", className, text),
    count: (n: number) => String(n),
    el: node,
    failed(error: unknown) { throw error; },
    haptic() {},
    icon: () => new FakeNode(),
    lockForm() {},
    nonce: () => String(Math.random()),
    async post(_path: string, body: { title: string }) { posts.push(body.title); return {}; },
    openSheet(options: { build(body: FakeNode): void; onClose(): void }) {
      close = () => { closed = true; options.onClose(); };
      const sheet = {
        body: new FakeNode(),
        close,
        main: { run: (work: () => Promise<void>) => work() },
        setMain(config: typeof main) { main = config; },
      };
      options.build(sheet.body);
      return sheet;
    },
    radioGroup: () => ({ node: new FakeNode() }),
    refresh() {},
    toast() {},
  };
  class Recorder {
    static isTypeSupported() { return true; }
    mimeType = "audio/webm";
    addEventListener() {}
    start() { recordings += 1; }
    stop() {}
  }
  runInNewContext(readFileSync("infra/public/app/dictate.js", "utf8"), {
    Blob, Date, MediaRecorder: Recorder, clearInterval() {}, setInterval: () => 1,
    navigator: { mediaDevices: { getUserMedia: () => new Promise((resolve) => { grant = resolve; }) } },
    window: { FamilyApp: FA, MediaRecorder: Recorder },
  });
  (FA as unknown as { dictate(options: { kind: string }): void }).dictate({ kind: "task" });
  return {
    box: nodes.find((item) => item.tag === "textarea")!,
    // The sheet's own close path, as a swipe down takes it.
    close: () => close(),
    closed: () => closed,
    grant: () => grant({ getTracks: () => [{ stop() { released += 1; } }] }),
    main: () => main!,
    posts,
    record: nodes.find((item) => item.className === "dictate-record")!,
    recordings: () => recordings,
    released: () => released,
  };
}

describe("dictation sheet", () => {
  it("lets go of a microphone granted after the sheet was closed instead of recording", async () => {
    const page = dictation();
    const asking = page.record.events.click!();
    page.close();
    page.grant();
    await asking;
    expect(page.recordings()).toBe(0);
    expect(page.released()).toBe(1);
  });

  it("keeps the lines over twenty in the open sheet for the next tap", async () => {
    const page = dictation();
    page.box.value = Array.from({ length: 23 }, (_, index) => `Дело ${index + 1}`).join("\n");
    page.box.events.input!();
    await page.main().onClick();
    expect(page.posts).toHaveLength(20);
    expect(page.closed()).toBe(false);
    expect(page.box.value.split("\n")).toEqual(["Дело 21", "Дело 22", "Дело 23"]);
    await page.main().onClick();
    expect(page.posts).toHaveLength(23);
    expect(page.closed()).toBe(true);
  });
});
