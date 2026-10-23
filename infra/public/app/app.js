// Mini App v2 core: Telegram glue, requests, error texts, dates and the shared data caches.
// Screens live in their own files and register on window.FamilyApp; ui.js holds the controls, router.js
// starts the page. Everything people or the server wrote reaches the page through textContent, never
// innerHTML. Identity is Telegram's signed initData, sent with every request; the server checks the rights.
"use strict";

(function () {
  const FA = window.FamilyApp = window.FamilyApp || {};
  const tg = window.Telegram && window.Telegram.WebApp;
  const initData = tg ? tg.initData : "";
  FA.tg = tg || null;
  FA.inTelegram = Boolean(initData);

  function applyTheme() {
    if (tg && tg.colorScheme) document.documentElement.dataset.theme = tg.colorScheme;
  }

  // Telegram for Android names the phone's class at the end of its user agent («…; SDK 34; LOW)»): a weak
  // phone gets a solid tab bar instead of a blur over the scrolling page, and no entrance (theme.css).
  const perf = /Telegram-Android\/\S+ \([^)]*;\s*(LOW|AVERAGE|HIGH)\)/u.exec(navigator.userAgent || "");
  if (perf) document.documentElement.dataset.perf = perf[1].toLowerCase();

  if (tg) {
    tg.ready();
    if (typeof tg.expand === "function") tg.expand();
    applyTheme();
    if (typeof tg.onEvent === "function") tg.onEvent("themeChanged", applyTheme);
    // A vertical swipe would close the app in the middle of a list scroll.
    if (typeof tg.disableVerticalSwipes === "function") tg.disableVerticalSwipes();
  }

  /**
   * Screens register here as their files load; router.js (loaded last) reads them.
   * `def`: { tab, parent (hash of the screen above, null for a root), parentLabel, title, render(view, arg, ctx) }.
   * `render` may return a cleanup; `ctx.guard` may be set to an async function that returns false to stay.
   */
  FA.screens = {};
  FA.screen = function screen(name, def) {
    FA.screens[name] = def;
  };

  FA.el = function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };

  /** A button that never submits a form by accident. */
  FA.button = function button(className, text, onClick) {
    const node = FA.el("button", className, text);
    node.type = "button";
    if (onClick) node.addEventListener("click", onClick);
    return node;
  };

  /** A person's text: isolated for mixed scripts, direction from its own first letters. */
  FA.bdi = function bdi(text, className) {
    const node = FA.el("bdi", className, text);
    node.dir = "auto";
    return node;
  };

  FA.haptic = function haptic(kind) {
    try {
      if (tg && tg.HapticFeedback) {
        if (kind === "select") tg.HapticFeedback.selectionChanged();
        else tg.HapticFeedback.notificationOccurred(kind);
      }
    } catch (_) { /* older clients */ }
  };

  FA.nonce = function nonce() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  };

  // ---- Requests -------------------------------------------------------------------------------------

  async function request(path, options) {
    let response;
    try {
      response = await fetch(path, {
        ...options,
        cache: "no-store",
        headers: { authorization: "tma " + initData, "content-type": "application/json" },
      });
    } catch (_) {
      const error = new Error("Нет связи. Проверьте интернет и повторите.");
      error.status = 0;
      throw error;
    }
    let body = null;
    try {
      body = await response.json();
    } catch (_) { /* empty or not JSON */ }
    if (!response.ok) {
      const error = new Error((body && body.message) || "Не получилось. Попробуйте ещё раз чуть позже.");
      error.status = response.status;
      error.code = body && body.code;
      throw error;
    }
    return body;
  }

  FA.get = (path) => request(path, { method: "GET" });

  /** Raw bytes (a preview image): the same signed header, so it is fetched here, never put in <img src>. */
  FA.getBlob = async function getBlob(path) {
    let response;
    try {
      response = await fetch(path, { cache: "no-store", headers: { authorization: "tma " + initData } });
    } catch (_) {
      const error = new Error("Нет связи. Проверьте интернет и повторите.");
      error.status = 0;
      throw error;
    }
    if (!response.ok) {
      const error = new Error("Не получилось загрузить.");
      error.status = response.status;
      throw error;
    }
    return response.blob();
  };

  /**
   * Every write carries a nonce: the server keys the operation by it, so a replay is not a second change.
   * One nonce per thing the person meant to do: the caller makes it when the action starts and passes the
   * same one to «Повторить», so a write that landed but whose answer was lost is not made twice.
   */
  FA.post = (path, body, nonce) => request(path, { body: JSON.stringify({ ...(body || {}), nonce: nonce || FA.nonce() }), method: "POST" });

  /** Raw bytes (a photo from the phone): the same signed header, the body as is, the JSON answer back. */
  FA.postBytes = async function postBytes(path, blob) {
    let response;
    try {
      response = await fetch(path, {
        body: blob, cache: "no-store", method: "POST",
        headers: { authorization: "tma " + initData, "content-type": blob.type || "application/octet-stream" },
      });
    } catch (_) {
      const error = new Error("Нет связи. Проверьте интернет и повторите.");
      error.status = 0;
      throw error;
    }
    let body = null;
    try {
      body = await response.json();
    } catch (_) { /* empty or not JSON */ }
    if (!response.ok) {
      const error = new Error((body && body.message) || "Не получилось. Попробуйте ещё раз чуть позже.");
      error.status = response.status;
      error.code = body && body.code;
      throw error;
    }
    return body;
  };

  FA.taskAction = (id, action, version, extra, nonce) =>
    FA.post("/app-api/tasks/" + encodeURIComponent(id) + "/" + action, { version, ...(extra || {}) }, nonce);

  // ---- Errors ---------------------------------------------------------------------------------------

  const STALE = "Доска открыта слишком давно. Закрой её и открой снова из чата с ботом.";
  const CONFLICT = "Это дело уже изменили. Обновил список.";

  FA.errorText = function errorText(error) {
    if (error && error.status === 401) return STALE;
    if (error && error.status === 409) return CONFLICT;
    return (error && error.message) || "Не получилось. Попробуйте ещё раз чуть позже.";
  };

  /**
   * The error stays where it happened, with «Повторить» when trying again makes sense.
   * A stale page (401) cannot be fixed by a retry, so it gets no button.
   */
  FA.errorBox = function errorBox(error, retry) {
    const box = FA.el("div", "inline-error");
    box.setAttribute("role", "alert");
    box.append(FA.icon("warning", "inline-error-icon"));
    const text = FA.el("div", "inline-error-text");
    text.append(FA.el("p", null, FA.errorText(error)));
    if (retry && !(error && (error.status === 401 || error.status === 404))) {
      text.append(FA.button("link-button", "Повторить", retry));
    }
    box.append(text);
    return box;
  };

  /**
   * After a refused write: a conflict means our copy is old, so say so and read it again; anything else
   * goes next to the control (or into a toast when there is no place for it).
   */
  FA.failed = function failed(error, place, retry) {
    FA.haptic("error");
    if (error && error.status === 409) {
      FA.board.invalidate();
      FA.toast(CONFLICT);
      FA.refresh();
      return;
    }
    if (place) {
      const old = place.querySelector(":scope > .inline-error");
      if (old) old.remove();
      place.append(FA.errorBox(error, retry));
    } else {
      FA.toast(FA.errorText(error), { error: true });
    }
  };

  // ---- Words and dates -----------------------------------------------------------------------------

  /** Russian plural: forms for 1, 2 and 5 («дело», «дела», «дел»). */
  FA.plural = function plural(n, forms) {
    const tens = Math.abs(n) % 100;
    const ones = tens % 10;
    if (tens > 10 && tens < 20) return forms[2];
    if (ones === 1) return forms[0];
    if (ones >= 2 && ones <= 4) return forms[1];
    return forms[2];
  };

  FA.count = (n, forms) => n + " " + FA.plural(n, forms);
  FA.TASKS = ["дело", "дела", "дел"];

  // Days travel as "YYYY-MM-DD" in the person's own calendar; UTC here only keeps the arithmetic exact.
  function utc(isoDay) {
    const [year, month, day] = isoDay.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }

  function format(isoDay, options) {
    return new Intl.DateTimeFormat("ru-RU", { ...options, timeZone: "UTC" }).format(utc(isoDay));
  }

  /** «Пятница, 16 октября» */
  FA.longDate = function longDate(isoDay) {
    const text = format(isoDay, { weekday: "long", day: "numeric", month: "long" });
    return text.charAt(0).toUpperCase() + text.slice(1);
  };

  /** «14 октября» */
  FA.dayMonth = (isoDay) => format(isoDay, { day: "numeric", month: "long" });

  /** «12 октября 2026» from an ISO instant, in the device's zone (memory dates are moments, not days). */
  FA.fullDate = function fullDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(date).replace(/\s*г\.$/u, "");
  };

  FA.addDays = function addDays(isoDay, days) {
    const date = utc(isoDay);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };

  /** «Выходные»: the next Saturday, a week on when today is Saturday (the server's rule, web-app-api.ts). */
  FA.weekend = function weekend(isoDay) {
    const day = utc(isoDay).getUTCDay();
    return FA.addDays(isoDay, (6 - day + 7) % 7 || 7);
  };

  /** Section titles come from the chat board («⚠️ Просрочено»); the page draws its own icon instead. */
  FA.plainTitle = (title) => String(title).replace(/^[\p{Extended_Pictographic}\p{S}️‍\s]+/u, "");

  // ---- UI memory (conveniences only) --------------------------------------------------------------

  FA.uiGet = function uiGet(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem("ui." + key));
      return value === null || value === undefined ? fallback : value;
    } catch (_) {
      return fallback;
    }
  };

  FA.uiSet = function uiSet(key, value) {
    try {
      localStorage.setItem("ui." + key, JSON.stringify(value));
    } catch (_) { /* storage may be blocked */ }
  };

  // ---- Shared data ----------------------------------------------------------------------------------

  /**
   * The board is read by several screens (add, mark done, projects, the card's «Перенести» needs its
   * `today`). One copy, dropped after every write so nothing acts on an old version.
   */
  FA.board = {
    data: null,
    async get(force) {
      if (force || !this.data) this.data = await FA.get("/app-api/board");
      return this.data;
    },
    invalidate() {
      this.data = null;
    },
  };

  // The bot's name and its case forms come from the server (`capabilities.agent`, TELEGRAM_AGENT_NAME); a name it
  // has no table for repeats the nominative in every case. Until that answer, the name this phone saw last, else a
  // plain word that agrees with the feminine verbs the pages use.
  const PLAIN_AGENT = {
    accusative: "помощницу", dative: "помощнице", genitive: "помощницы",
    instrumental: "помощницей", nominative: "помощница", prepositional: "помощнице",
  };
  const validAgent = (cases) => Boolean(cases) && Object.keys(PLAIN_AGENT).every((form) => typeof cases[form] === "string" && cases[form]);
  let agent = validAgent(FA.uiGet("agent", null)) ? FA.uiGet("agent", null) : PLAIN_AGENT;
  /** The name in a case, as written mid-sentence; `FA.Agent` starts a sentence. */
  FA.agent = (form) => agent[form || "nominative"];
  FA.Agent = (form) => {
    const word = FA.agent(form);
    return word.charAt(0).toUpperCase() + word.slice(1);
  };

  let capabilities = null;
  /** What this server can do; a failed read hides the optional parts rather than promising them. */
  FA.capabilities = async function () {
    if (capabilities) return capabilities;
    try {
      capabilities = await FA.get("/app-api/capabilities");
    } catch (_) {
      return { google: false, grocery: false, images: false, video: false };
    }
    if (capabilities.agent && validAgent(capabilities.agent.cases)) {
      agent = capabilities.agent.cases;
      FA.uiSet("agent", agent);
    }
    return capabilities;
  };

  /**
   * «Попросить в чате»: the bot sends the person an example or a command in the private chat; the page
   * sends only the id. The app stays open: the person goes to the chat when they choose (closing on its own
   * read as being thrown out, review of 21 October 2026).
   */
  FA.hint = async function hint(id, nonce) {
    await FA.post("/app-api/hint", { id }, nonce);
    FA.haptic("success");
    const close = tg && typeof tg.close === "function" ? () => tg.close() : null;
    FA.toast("Пример в чате с " + FA.agent("instrumental"), close ? { action: { label: "Открыть чат", run: async () => close() }, sticky: true } : {});
  };

  FA.openLink = function openLink(url) {
    // Links come from what people saved (an idea's source, a message): only the web and Telegram open.
    if (!/^https?:\/\//iu.test(String(url))) return;
    if (tg && typeof tg.openTelegramLink === "function" && /^https:\/\/t\.me\//u.test(url)) {
      tg.openTelegramLink(url);
    } else if (tg && typeof tg.openLink === "function") {
      tg.openLink(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
  };

  /**
   * A segmented choice (role=radiogroup): one of a few options, or none yet. Arrow keys move the choice,
   * as in any radio group; only the chosen option is in the Tab order. `options` = [[value, label], …].
   */
  FA.radioGroup = function radioGroup(options) {
    const group = FA.el("div", "segments");
    group.setAttribute("role", "radiogroup");
    if (options.labelledBy) group.setAttribute("aria-labelledby", options.labelledBy);
    let value = options.value === undefined ? null : options.value;
    const buttons = options.options.map(([id, label]) => {
      const node = FA.button("segment", label, () => choose(id, true));
      node.setAttribute("role", "radio");
      node.dataset.value = id;
      node.addEventListener("keydown", (event) => {
        const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const at = buttons.indexOf(node);
        let next = node;
        for (let k = 1; k <= buttons.length; k += 1) {
          const candidate = buttons[(at + step * k + buttons.length * k) % buttons.length];
          if (!candidate.disabled) {
            next = candidate;
            break;
          }
        }
        choose(next.dataset.value, true);
        next.focus();
      });
      group.append(node);
      return node;
    });
    function paint() {
      buttons.forEach((node, index) => {
        const on = node.dataset.value === value;
        node.setAttribute("aria-checked", String(on));
        node.tabIndex = on || (value === null && index === 0) ? 0 : -1;
      });
    }
    function choose(id, byPerson) {
      if (id === value) return;
      value = id;
      paint();
      if (byPerson) {
        FA.haptic("select");
        if (options.onChange) options.onChange(id);
      }
    }
    paint();
    return {
      disable(id, disabled) {
        const node = buttons.find((item) => item.dataset.value === id);
        if (node) node.disabled = Boolean(disabled);
      },
      node: group,
      set: (id) => choose(id, false),
      value: () => value,
    };
  };

  // Our own 24-hour picker: <input type=time> follows the device and shows «11:00 PM» on English phones.
  FA.HALF_HOURS = Array.from({ length: 48 }, (_, i) => String(Math.floor(i / 2)).padStart(2, "0") + (i % 2 ? ":30" : ":00"));
  /** «08:00» → «8:00» */
  FA.clockText = (value) => value.replace(/^0(\d)/u, "$1");
  FA.timeSelect = function timeSelect(className) {
    const select = FA.el("select", className || "text-input time-select");
    FA.HALF_HOURS.forEach((value) => select.append(new Option(FA.clockText(value), value)));
    return select;
  };

  /**
   * While a form is being sent, nothing in it can change: what goes out is what the person sees. Controls
   * that were already disabled stay so afterwards.
   */
  FA.lockForm = function lockForm(container, locked) {
    container.querySelectorAll("button, input, select, textarea").forEach((node) => {
      if (locked) {
        if (node.disabled) return;
        node.disabled = true;
        node.dataset.locked = "1";
      } else if (node.dataset.locked) {
        node.disabled = false;
        delete node.dataset.locked;
      }
    });
    container.toggleAttribute("aria-busy", locked);
  };

  /** Disable the pressed control, show that it works, keep its width; always give it back. */
  FA.busy = async function busy(button, work) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.classList.add("is-busy");
    try {
      return await work();
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.classList.remove("is-busy");
    }
  };
})();
