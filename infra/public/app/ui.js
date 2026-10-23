// Mini App controls shared by every screen: the main button, the back button, toasts, sheets, dialogs,
// switches and page scaffolding. Telegram's native MainButton, BackButton and popups are used when the
// client has them; the in-page copies exist only for a client (or a test stand) without them, so the page
// never draws a second MainButton next to the native one.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button, tg } = FA;
  const nativeMain = Boolean(tg && tg.MainButton && typeof tg.MainButton.setText === "function");
  const nativeBack = Boolean(tg && tg.BackButton && typeof tg.BackButton.show === "function");
  FA.nativeBack = nativeBack;

  // ---- Main button ---------------------------------------------------------------------------------

  // One main button, many owners: the current screen at the bottom, each open sheet above it. Only the top
  // owner paints and receives taps, so a late answer for a screen that is gone, or for a screen under a
  // sheet, cannot put its action on the button. An owner's lock lives on the owner, not on the button:
  // changing the label or the action while a request is out does not unlock it.
  const owners = [];
  let dock = null;
  const top = () => owners[owners.length - 1] || null;

  function tap() {
    const owner = top();
    if (owner && owner.config && !owner.busy && !owner.config.disabled) owner.config.onClick();
  }
  if (nativeMain) tg.MainButton.onClick(tap);

  function dockButton() {
    if (!dock) {
      dock = el("div", "main-dock");
      dock.append(button("main-button", "", tap));
      document.body.append(dock);
    }
    return dock.firstChild;
  }
  document.addEventListener("keydown", (event) => {
    // The event's target, not the focus: the sheet's own handler may have just moved the focus here.
    if (event.key !== "Tab" || !dock || event.target !== dock.firstChild || !FA.sheet.isOpen()) return;
    const sheet = document.querySelector(".sheet-backdrop:last-of-type .sheet");
    const items = sheet ? Array.from(sheet.querySelectorAll(FOCUSABLE)).filter((node) => node.offsetParent !== null) : [];
    if (items.length === 0) return;
    (event.shiftKey ? items[items.length - 1] : items[0]).focus();
    event.preventDefault();
  });
  FA.dockButton = () => (dock && !dock.hidden && !dock.firstChild.disabled ? dock.firstChild : null);

  function paint() {
    const owner = top();
    const config = owner && owner.config;
    const busy = Boolean(owner && owner.busy);
    if (nativeMain) {
      const mb = tg.MainButton;
      if (!config) {
        mb.hideProgress();
        mb.hide();
        return;
      }
      mb.setText(config.text);
      if (config.disabled || busy) mb.disable(); else mb.enable();
      if (busy) mb.showProgress(false); else mb.hideProgress();
      mb.show();
      return;
    }
    const node = dockButton();
    document.body.classList.toggle("has-dock", Boolean(config));
    dock.hidden = !config;
    if (!config) return;
    node.textContent = config.text;
    node.disabled = Boolean(config.disabled) || busy;
    node.classList.toggle("is-busy", busy);
    if (busy) node.setAttribute("aria-busy", "true"); else node.removeAttribute("aria-busy");
  }

  /**
   * An owner of the main button: `set({text, onClick, disabled})` or null to hide, `update(changes)`,
   * `run(work)` with the button in progress (a second tap does nothing until the server answers),
   * `busy` while that runs.
   */
  FA.mainOwner = function mainOwner() {
    const owner = {
      busy: false,
      config: null,
      set(config) {
        owner.config = config || null;
        if (top() === owner) paint();
      },
      update(changes) {
        if (owner.config) owner.set({ ...owner.config, ...changes });
      },
      async run(work) {
        if (owner.busy) return undefined;
        owner.busy = true;
        if (top() === owner) paint();
        try {
          return await work();
        } finally {
          owner.busy = false;
          if (top() === owner) paint();
        }
      },
    };
    return owner;
  };

  FA.main = {
    /** The router's: a new screen replaces every owner below the sheets (sheets are closed first). */
    screen(owner) {
      owners.length = 0;
      owners.push(owner);
      paint();
    },
    push(owner) {
      owners.push(owner);
      paint();
    },
    pop(owner) {
      const index = owners.indexOf(owner);
      if (index !== -1) owners.splice(index, 1);
      paint();
    },
  };

  // ---- Back button ---------------------------------------------------------------------------------

  let backVisible = false;
  function onBack() {
    if (FA.sheet.closeTop()) return;
    FA.back();
  }
  if (nativeBack) tg.BackButton.onClick(onBack);

  FA.setBack = function setBack(visible) {
    backVisible = visible;
    if (nativeBack) {
      if (visible || FA.sheet.isOpen()) tg.BackButton.show(); else tg.BackButton.hide();
    }
  };

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (FA.sheet.closeTop()) event.preventDefault();
  });

  // ---- Toast ---------------------------------------------------------------------------------------

  const region = el("div", "toast-region");
  region.setAttribute("aria-live", "polite");
  let toastTimer = null;
  let toastLeft = 0;
  let toastStarted = 0;

  function dropToast() {
    clearTimeout(toastTimer);
    toastTimer = null;
    region.replaceChildren();
  }

  function startTimer(ms) {
    toastLeft = ms;
    toastStarted = Date.now();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(dropToast, ms);
  }

  /**
   * One toast at a time, tied to the last action. Five seconds (guide §5); the timer stops while a finger
   * or the focus is inside, so «Вернуть» can be read and reached. Errors stay until closed.
   */
  FA.toast = function toast(text, options) {
    const opts = options || {};
    dropToast();
    const box = el("div", "toast" + (opts.error ? " toast-error" : ""));
    if (opts.error) box.setAttribute("role", "alert");
    box.append(FA.icon(opts.error ? "warning" : "check-circle", "toast-icon"));
    box.append(el("p", "toast-text", text));
    if (opts.action) {
      box.append(button("toast-action", opts.action.label, async (event) => {
        await FA.busy(event.currentTarget, opts.action.run);
      }));
    }
    if (opts.error || opts.sticky) {
      const close = button("toast-close", "", dropToast);
      close.setAttribute("aria-label", "Закрыть сообщение");
      close.append(FA.icon("close"));
      box.append(close);
    } else {
      const pause = () => {
        if (!toastTimer) return;
        clearTimeout(toastTimer);
        toastTimer = null;
        toastLeft = Math.max(1500, toastLeft - (Date.now() - toastStarted));
      };
      const resume = () => {
        if (!toastTimer && region.contains(box)) startTimer(toastLeft);
      };
      box.addEventListener("pointerdown", pause);
      box.addEventListener("focusin", pause);
      box.addEventListener("pointerleave", resume);
      box.addEventListener("focusout", (event) => {
        if (!box.contains(event.relatedTarget)) resume();
      });
      startTimer(opts.duration || 5000);
    }
    region.append(box);
  };
  FA.toast.clear = dropToast;

  // ---- Sheets --------------------------------------------------------------------------------------

  const sheets = [];
  const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, a[href], [tabindex='0']";

  /**
   * A bottom sheet: a modal dialog over the screen. Escape, the back button, the backdrop and the close
   * button all close it; focus moves in and comes back to the control that opened it. While it is open,
   * its own main action (if any) replaces the screen's and the screen's comes back on close.
   */
  FA.openSheet = function openSheet(options) {
    const opener = document.activeElement;
    const backdrop = el("div", "sheet-backdrop");
    const sheet = el("div", "sheet");
    const titleId = "sheet-title-" + sheets.length;
    sheet.setAttribute("role", options.alert ? "alertdialog" : "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", titleId);
    const head = el("div", "sheet-head");
    const title = el("h2", "sheet-title", options.title);
    title.id = titleId;
    head.append(title);
    if (!options.alert) {
      const close = button("icon-button sheet-close", "", () => handle.close());
      close.setAttribute("aria-label", "Закрыть");
      close.append(FA.icon("close"));
      head.append(close);
    }
    const body = el("div", "sheet-body");
    sheet.append(head, body);
    backdrop.append(sheet);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop && !options.alert) handle.close();
    });
    sheet.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      // The in-page main button sits outside the dialog but is its action («Сохранить дату»), so it is
      // part of the cycle; Telegram's native button is not in the page and needs no place here.
      const items = Array.from(sheet.querySelectorAll(FOCUSABLE)).filter((node) => node.offsetParent !== null);
      const action = FA.dockButton();
      if (action) items.push(action);
      if (items.length === 0) return;
      // The cycle is moved by hand: the in-page button is not next to the dialog in the page's order.
      const at = items.indexOf(document.activeElement);
      const next = at === -1 ? 0 : (at + (event.shiftKey ? -1 : 1) + items.length) % items.length;
      items[next].focus();
      event.preventDefault();
    });

    let closed = false;
    const main = FA.mainOwner();
    main.set(options.main || null);
    const handle = {
      body,
      main,
      sheet,
      setMain(config) {
        main.set(config);
      },
      close(result) {
        if (closed) return;
        closed = true;
        sheets.splice(sheets.indexOf(handle), 1);
        backdrop.remove();
        FA.main.pop(main);
        if (sheets.length === 0) {
          document.getElementById("app").inert = false;
          document.body.classList.remove("sheet-open");
        }
        FA.setBack(backVisible);
        if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
        if (options.onClose) options.onClose(result);
      },
    };
    sheets.push(handle);
    FA.main.push(main);
    if (options.build) options.build(body, handle);
    document.body.append(backdrop);
    document.getElementById("app").inert = true;
    document.body.classList.add("sheet-open");
    FA.setBack(backVisible);
    const target = body.querySelector("[autofocus]") || body.querySelector(FOCUSABLE) || sheet.querySelector(FOCUSABLE) || title;
    if (target === title) title.tabIndex = -1;
    target.focus();
    return handle;
  };

  FA.sheet = {
    isOpen: () => sheets.length > 0,
    closeTop() {
      if (sheets.length === 0) return false;
      sheets[sheets.length - 1].close();
      return true;
    },
    closeAll() {
      while (sheets.length > 0) sheets[sheets.length - 1].close();
    },
  };

  function canPopup() {
    try {
      return Boolean(tg && typeof tg.showPopup === "function" && tg.isVersionAtLeast && tg.isVersionAtLeast("6.2"));
    } catch (_) {
      return false;
    }
  }

  /**
   * A short question with up to three answers: `buttons` = [{id, text, kind: "destructive"|"default"}].
   * Telegram's popup when it has one; otherwise an in-page dialog, never window.confirm.
   * Resolves with the chosen id, or null when dismissed.
   */
  FA.ask = function ask(options) {
    return new Promise((resolve) => {
      if (canPopup()) {
        try {
          tg.showPopup({
            buttons: options.buttons.map((item) => ({ id: item.id, text: item.text, type: item.kind === "destructive" ? "destructive" : "default" })),
            message: options.message || options.title,
            title: options.message ? options.title : undefined,
          }, (id) => resolve(id || null));
          return;
        } catch (_) { /* fall through to the page */ }
      }
      let answer = null;
      FA.openSheet({
        alert: true,
        build(body, handle) {
          if (options.message) body.append(el("p", "sheet-text", options.message));
          const row = el("div", "dialog-buttons");
          // The first safe answer takes the focus, so Enter never deletes by accident.
          let focused = false;
          options.buttons.forEach((item) => {
            const node = button("secondary-button" + (item.kind === "destructive" ? " danger" : ""), item.text, () => {
              answer = item.id;
              handle.close();
            });
            if (!focused && item.kind !== "destructive") {
              node.setAttribute("autofocus", "");
              focused = true;
            }
            row.append(node);
          });
          body.append(row);
        },
        onClose: () => resolve(answer),
        title: options.title,
      });
    });
  };

  /** «Удалить это сведение?» / «Удалить» / «Оставить»: true only for the destructive answer. */
  FA.confirm = async function confirm(title, okText, message) {
    const id = await FA.ask({ buttons: [{ id: "ok", kind: "destructive", text: okText }, { id: "keep", text: "Оставить" }], message, title });
    return id === "ok";
  };

  // ---- Page scaffolding ----------------------------------------------------------------------------

  /** Title, optional subtitle; nested screens without Telegram's BackButton get an in-page «‹ Доска». */
  FA.header = function header(view, options) {
    const box = el("header", "page-header");
    const parent = FA.route && FA.route.parentLabel;
    if (!nativeBack && parent) {
      const back = button("back-link", "", () => FA.back());
      back.append(FA.icon("chevron-left"), el("span", null, parent));
      box.append(back);
    }
    const title = el("h1", "page-title", options.title);
    title.tabIndex = -1;
    box.append(title);
    if (options.subtitle) box.append(el("p", "page-subtitle", options.subtitle));
    view.append(box);
    return box;
  };

  /** Static skeleton with the real gutters and «Загружаю…»; no shimmer (reduced motion is the default). */
  FA.skeleton = function skeleton(view, text) {
    const box = el("div", "skeleton");
    box.setAttribute("aria-busy", "true");
    box.append(el("p", "status", text || "Загружаю…"));
    for (let i = 0; i < 3; i += 1) box.append(el("div", "skeleton-card"));
    view.append(box);
    return box;
  };

  /** Loads, shows the skeleton meanwhile, and puts a load error with «Повторить» in its place. */
  FA.load = async function load(view, work, text) {
    const skeleton = FA.skeleton(view, text);
    let result;
    try {
      result = await work();
    } catch (error) {
      if (view.isConnected) skeleton.replaceWith(FA.errorBox(error, () => FA.refresh()));
      throw error;
    }
    // The person left while this was loading: stop the render here, before it touches anything shared.
    if (!view.isConnected) throw new Error("stale render");
    skeleton.remove();
    return result;
  };

  FA.empty = function empty(title, text, iconName) {
    const box = el("div", "empty");
    box.append(FA.icon(iconName || "notebook", "empty-icon"));
    box.append(el("h2", "empty-title", title));
    if (text) box.append(el("p", "empty-text", text));
    return box;
  };

  FA.card = (className) => el("div", "card" + (className ? " " + className : ""));

  FA.sectionTitle = (text, className) => el("h2", "section-title" + (className ? " " + className : ""), text);

  /** A list row that goes somewhere: icon, title, subtitle, chevron; the whole row is one button. */
  FA.navRow = function navRow(options) {
    const row = button("nav-row" + (options.danger ? " danger" : ""), "", options.onClick);
    if (options.icon) row.append(FA.icon(options.icon, "nav-row-icon"));
    const text = el("span", "nav-row-text");
    text.append(el("span", "nav-row-title", options.title));
    if (options.subtitle) text.append(el("span", "nav-row-sub", options.subtitle));
    row.append(text, FA.icon(options.external ? "external" : "chevron-right", "nav-row-chevron"));
    return row;
  };

  let switchCount = 0;
  /**
   * A switch row (guide §5): the label and the control are one target, role="switch" with aria-checked.
   * A disabled switch says why in words, not only by fading.
   */
  FA.switchRow = function switchRow(options) {
    switchCount += 1;
    const row = el("div", "switch-row");
    const text = el("div", "switch-text");
    const label = el("span", "switch-label", options.label);
    label.id = "switch-" + switchCount;
    const sub = el("span", "switch-sub", options.sub || "");
    sub.hidden = !options.sub;
    text.append(label, sub);
    const control = button("switch", "", () => {
      if (control.disabled) return;
      api.set(control.getAttribute("aria-checked") !== "true");
      FA.haptic("select");
      if (options.onChange) options.onChange(api.checked());
    });
    control.setAttribute("role", "switch");
    control.setAttribute("aria-labelledby", label.id);
    text.addEventListener("click", () => control.click());
    row.append(text, control);
    const api = {
      row,
      control,
      checked: () => control.getAttribute("aria-checked") === "true",
      set(value) {
        control.setAttribute("aria-checked", String(Boolean(value)));
      },
      disable(disabled, why) {
        control.disabled = Boolean(disabled);
        row.classList.toggle("is-disabled", Boolean(disabled));
        sub.textContent = disabled && why ? why : options.sub || "";
        sub.hidden = !sub.textContent;
      },
    };
    api.set(options.checked);
    return api;
  };

  document.addEventListener("DOMContentLoaded", () => document.body.append(region));
})();
