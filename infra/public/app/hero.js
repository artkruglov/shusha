// The v9 look (docs/design/v9, v10): a hero per root screen (a soft scene fading into the page, Шуша on the
// right, a serif greeting on the left), calm illustrated empty states, small poses on inner screens, and the
// «Поручите Шуше…» composer. The art is decorative: alt="", the words carry the meaning.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;

  const SIZE = { scene: [1170, 780], shusha: [512, 512] };

  /** A picture from img/: scenes are wide, poses square; only the hero's first paint is eager. */
  FA.art = function art(name, className, eager) {
    const img = el("img", className);
    img.src = "img/" + name + ".webp";
    img.alt = "";
    const [width, height] = name.startsWith("scene-") ? SIZE.scene : SIZE.shusha;
    img.width = width;
    img.height = height;
    img.decoding = "async";
    if (!eager) img.loading = "lazy";
    return img;
  };

  /**
   * The hero: `{scene, shusha, caption, lines:[…], sub, light}`. `lines` are the serif greeting, one block
   * per line so it breaks where the words do; `light` puts light text on a dark (evening) scene.
   */
  FA.hero = function hero(view, options) {
    const box = el("header", "hero" + (options.light ? " hero-light" : "") + (options.scene ? "" : " hero-plain")
      + (options.compact ? " hero-compact" : ""));
    if (options.scene) box.append(FA.art(options.scene, "hero-scene", true));
    if (options.shusha) box.append(FA.art(options.shusha, "hero-shusha", true));
    const text = el("div", "hero-text");
    if (FA.route && FA.route.parentLabel && !FA.nativeBack) {
      const back = button("back-link", "", () => FA.back());
      back.append(FA.icon("chevron-left"), el("span", null, FA.route.parentLabel));
      text.append(back);
    }
    if (options.caption) text.append(el("p", "hero-caption", options.caption));
    const title = el("h1", "hero-title page-title");
    title.tabIndex = -1;
    options.lines.forEach((line) => title.append(el("span", "hero-line", line)));
    text.append(title);
    if (options.sub) text.append(el("p", "hero-sub", options.sub));
    box.append(text);
    view.append(box);
    return box;
  };

  /** Is the page drawn dark (Telegram's scheme, or the system's outside Telegram)? */
  FA.isDark = function isDark() {
    const theme = document.documentElement.dataset.theme;
    if (theme) return theme === "dark";
    return matchMedia("(prefers-color-scheme: dark)").matches;
  };

  /**
   * Empty states (v9 empty.jpg): Шуша resting, one warm serif sentence and a quiet line. Every screen's
   * FA.empty(title, text) goes through here; `pose` is "sleep" (nothing to do) or "think" (nothing found).
   */
  FA.empty = function empty(title, text, pose) {
    const box = el("div", "empty calm");
    box.append(FA.art(pose === "think" ? "shusha-think" : "shusha-sleep", "calm-art"));
    box.append(el("h2", "empty-title calm-title", title));
    if (text) box.append(el("p", "empty-text", text));
    return box;
  };

  // Inner screens get a small pose next to their title: FA.header(view, {title, shusha: "shusha-basket"}).
  const plainHeader = FA.header;
  FA.header = function header(view, options) {
    const box = plainHeader(view, options);
    if (options.shusha) {
      box.classList.add("page-header-art");
      box.append(FA.art(options.shusha, "header-shusha", true));
    }
    return box;
  };

  const PASTELS = 6;
  /** A pastel circle with the first letter; the colour follows the name, so a person keeps theirs. */
  FA.avatar = function avatar(name, className) {
    const text = String(name || "?").trim();
    let hash = 0;
    for (const char of text) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    const circle = el("span", "avatar avatar-" + (hash % PASTELS) + (className ? " " + className : ""), Array.from(text)[0] || "?");
    circle.setAttribute("aria-hidden", "true");
    return circle;
  };

  /**
   * «Поручите Шуше…»: there is no chat in the app yet, so the composer does the nearest real thing.
   * Text and the arrow make a task; «Дело» opens the add page with the text; «Купить» puts the text into
   * the shopping list; «Напомнить», «Найти» and the mic send an example into the chat. The chips show
   * while the field is in use, so the bar stays one line above the tabs.
   */
  FA.askBar = function askBar(view, ctx, onAdded) {
    const bar = el("div", "ask-bar");
    const errors = el("div", "ask-errors");
    const chips = el("div", "ask-chips");
    const row = el("div", "ask-row");
    const input = el("input", "ask-input");
    input.type = "text";
    input.maxLength = 300;
    // Says what it does: the text becomes a task as written, no model reads it.
    input.placeholder = "Новое дело…";
    input.setAttribute("aria-label", "Новое дело");
    input.enterKeyHint = "send";
    const mic = button("ask-mic", "");
    mic.setAttribute("aria-label", "Надиктовать");
    mic.append(FA.icon("mic"));
    const send = button("ask-send", "");
    send.setAttribute("aria-label", "Записать дело");
    send.append(FA.icon("send-up"));
    row.append(FA.icon("sparkle", "ask-spark"), input, mic, send);
    bar.append(errors, chips, row);
    view.append(bar);
    document.body.classList.add("has-ask");

    // Every text sent is one operation: a retry after a lost answer resends the same nonce.
    let last = null;
    const nonceFor = (kind, text) => {
      if (!last || last.kind !== kind || last.text !== text) last = { kind, nonce: FA.nonce(), text };
      return last.nonce;
    };
    const busy = () => bar.hasAttribute("aria-busy");
    const shown = (on) => bar.classList.toggle("is-open", on);

    async function write(kind, text, control) {
      if (busy()) return;
      errors.replaceChildren();
      const nonce = nonceFor(kind, text);
      FA.lockForm(bar, true);
      try {
        await FA.busy(control, () => (kind === "task"
          ? FA.post("/app-api/tasks", { title: text }, nonce)
          : FA.post("/app-api/shopping", { title: text }, nonce)));
      } catch (error) {
        FA.lockForm(bar, false);
        FA.failed(error, errors, () => write(kind, text, control));
        return;
      }
      FA.lockForm(bar, false);
      last = null;
      input.value = "";
      FA.haptic("success");
      FA.toast(kind === "task" ? "Записала: " + text : "Добавила в покупки: " + text);
      if (kind === "task") {
        FA.board.invalidate();
        if (onAdded && ctx.live()) onAdded();
      }
    }

    const hintNonces = {};
    const ask = (id, control) => FA.askInChat(id, (work) => FA.busy(control, work), errors, hintNonces[id] || (hintNonces[id] = FA.nonce()));
    const CHIPS = [
      ["Дело", () => { FA.addDraft = input.value.trim(); FA.go("#add"); }],
      ["Купить", (chip) => (input.value.trim() ? write("shopping", input.value.trim(), chip) : FA.go("#shopping"))],
      ["Напомнить", (chip) => ask("skill-reminder", chip)],
      ["Найти", (chip) => ask("skill-search", chip)],
    ];
    CHIPS.forEach(([label, run]) => {
      const chip = button("chip ask-chip", label, () => run(chip));
      chips.append(chip);
    });
    // Dictation in the app itself (dictate.js); the chat's voice note is no longer the only way.
    mic.addEventListener("click", () => FA.dictate({ kind: "task" }));
    send.addEventListener("click", () => {
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      write("task", text, send);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      send.click();
    });
    input.addEventListener("focus", () => shown(true));
    // On a phone a tap on a chip may not focus it: give the tap time to land before the chips go.
    bar.addEventListener("focusout", () => {
      setTimeout(() => {
        if (!bar.contains(document.activeElement) && !input.value.trim()) shown(false);
      }, 250);
    });
    input.addEventListener("input", () => shown(true));
    // A redraw puts the new screen's bar on the page before this one's cleanup runs (router.js).
    return () => {
      if (!document.querySelector(".ask-bar")) document.body.classList.remove("has-ask");
    };
  };
})();
