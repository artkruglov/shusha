// Mini App router: screens by `location.hash`, the bottom tabs on root screens, Telegram's BackButton on
// nested ones. Loaded last, after every screen file has registered itself with FA.screen().
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el } = FA;
  const screens = FA.screens;
  const view = () => document.getElementById("view");

  const TABS = [
    { hash: "#board", icon: "home", label: "Сегодня", name: "board" },
    { hash: "#family", icon: "people", label: "Семья", name: "family" },
    { hash: "#create", icon: "sparkle", label: "Создать", name: "create" },
    { hash: "#more", icon: "dots", label: "Ещё", name: "more" },
  ];

  let tabBar = null;
  function buildTabs() {
    tabBar = el("nav", "tabs");
    tabBar.setAttribute("aria-label", "Разделы");
    TABS.forEach((tab) => {
      const link = el("a", "tab");
      link.href = tab.hash;
      link.dataset.tab = tab.name;
      link.append(FA.icon(tab.icon, "tab-icon"), el("span", "tab-label", tab.label));
      tabBar.append(link);
    });
    document.body.append(tabBar);
  }

  function paintTabs(def) {
    const root = !def.parent;
    tabBar.hidden = !root;
    document.body.classList.toggle("has-tabs", root);
    tabBar.querySelectorAll(".tab").forEach((link) => {
      if (link.dataset.tab === def.tab) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }

  function parse(hash) {
    const raw = (hash || "").replace(/^#/u, "");
    const slash = raw.indexOf("/");
    const name = slash === -1 ? raw : raw.slice(0, slash);
    const arg = slash === -1 ? null : decodeURIComponent(raw.slice(slash + 1));
    return screens[name] ? { arg, name } : { arg: null, name: "board" };
  }

  // In-app history: a back step returns to where the person came from, or to the screen above when the
  // app was opened straight on a nested screen (a link from the chat).
  const trail = [];
  let current = null;
  let restoring = false;

  FA.back = function back() {
    if (trail.length > 1) {
      history.back();
    } else if (current && current.def.parent) {
      location.replace(current.def.parent);
    }
  };

  /** Swap the current screen for another without a new step back (a task that came back with a new id). */
  let replacing = false;
  FA.replace = function replace(hash) {
    if (location.hash === hash) {
      FA.refresh();
      return;
    }
    replacing = true;
    location.replace(hash);
  };

  FA.go = function go(hash) {
    if (location.hash === hash) FA.refresh(); else location.hash = hash;
  };

  /** Draw the current screen again from the server, keeping the scroll position. */
  FA.refresh = function refresh() {
    show(location.hash, true);
  };

  // Each navigation gets its own token and main-button owner. A render that finishes after the person has
  // moved on is stale: it gets no say over the main button, the scroll, the focus or the cleanup.
  let navToken = 0;
  // The cleanup of the screen on display, and a redraw of it being drawn out of sight.
  let shownCleanup = null;
  let pending = null;

  async function show(hash, keepScroll) {
    const target = parse(hash);
    const def = screens[target.name];
    const scroll = window.scrollY;
    // A redraw of the screen on display (after a change, back from the background, a pull) is drawn out of
    // sight and swapped in when ready: the old one stays meanwhile, so the page neither blanks nor jumps.
    const quiet = Boolean(keepScroll && current && current.def === def && current.ctx.hash === (hash || "#board"));
    if (pending) {
      pending.remove();
      pending = null;
    }
    FA.sheet.closeAll();
    navToken += 1;
    const token = navToken;
    const ctx = { guard: null, hash: hash || "#board", live: () => token === navToken, main: FA.mainOwner() };
    current = { ctx, def };
    // A quiet redraw takes the main button over only when it is on screen, so the button does not blink.
    if (!quiet) FA.main.screen(ctx.main);
    // «‹ Сегодня», «‹ Закрытые»…: the back link names the screen it returns to, the one the person came
    // from; opened straight from the chat, it names the screen above.
    const previous = trail.length > 1 && trail[trail.length - 1] === ctx.hash ? screens[parse(trail[trail.length - 2]).name] : null;
    const backTo = previous && previous !== def ? previous.title : def.parentLabel;
    FA.route = { arg: target.arg, name: target.name, parentLabel: def.parent ? backTo : null };
    paintTabs(def);
    FA.setBack(Boolean(def.parent));
    document.title = def.title || "Доска";
    const fresh = el("main", "view");
    fresh.tabIndex = -1;
    if (quiet) {
      fresh.hidden = true;
      view().after(fresh);
      pending = fresh;
    } else {
      fresh.id = "view";
      // The entrance (hero fade, cards rising) plays when a screen opens, not on every redraw after a change.
      if (!keepScroll) fresh.classList.add("is-entering");
      view().replaceWith(fresh);
      // After the old screen is off the page, as in a quiet redraw.
      if (shownCleanup) shownCleanup();
      shownCleanup = null;
      if (!keepScroll) window.scrollTo(0, 0);
    }
    let cleanup = null;
    let failure = null;
    try {
      cleanup = await def.render(fresh, target.arg, ctx);
    } catch (error) {
      // FA.load already put the error with «Повторить» on the screen, or the render was stale.
      failure = error;
    }
    if (!ctx.live()) {
      if (typeof cleanup === "function") cleanup();
      return;
    }
    cleanup = typeof cleanup === "function" ? cleanup : null;
    if (quiet) {
      pending = null;
      if (failure) {
        // The screen on display stays as it was; what went wrong goes into a toast.
        fresh.remove();
        if (cleanup) cleanup();
        FA.toast(FA.errorText(failure), { error: true });
        return;
      }
      const old = view();
      const at = window.scrollY;
      // Off the page before its cleanup, so what the cleanup looks for on the page is the new screen's.
      old.remove();
      if (shownCleanup) shownCleanup();
      shownCleanup = cleanup;
      fresh.id = "view";
      fresh.hidden = false;
      window.scrollTo(0, at);
      FA.main.screen(ctx.main);
      return;
    }
    shownCleanup = cleanup;
    if (keepScroll) window.scrollTo(0, scroll);
    else {
      const title = fresh.querySelector(".page-title");
      // Move focus to the new screen's title, unless the screen already put it somewhere (a form's field).
      const placed = fresh.contains(document.activeElement) && document.activeElement !== fresh;
      if (title && trail.length > 1 && !placed) title.focus({ preventScroll: true });
    }
  }

  window.addEventListener("hashchange", async (event) => {
    if (restoring) {
      restoring = false;
      return;
    }
    const oldHash = new URL(event.oldURL).hash || "#board";
    // A screen with unsaved changes may ask first; staying puts the old address back without a redraw.
    if (current && current.ctx.guard) {
      const leave = await current.ctx.guard();
      if (!leave) {
        restoring = true;
        location.hash = oldHash;
        return;
      }
    }
    const hash = location.hash || "#board";
    if (replacing) {
      replacing = false;
      trail[trail.length - 1] = hash;
    } else if (trail.length > 1 && trail[trail.length - 2] === hash) trail.pop(); else trail.push(hash);
    show(hash, false);
  });

  // Root lists are read again when the app comes back to the front: the family may have changed them.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !current || current.def.parent || FA.sheet.isOpen()) return;
    if (current.ctx.guard) return;
    // A half-written «Поручите Шуше…» stays: the person may have gone to the chat to copy something.
    const draft = document.querySelector("#view .ask-input");
    if (draft && draft.value.trim()) return;
    FA.board.invalidate();
    FA.refresh();
  });

  // Pull down at the top of a root screen to read it again.
  let pullStart = null;
  window.addEventListener("touchstart", (event) => {
    pullStart = window.scrollY <= 0 && !FA.sheet.isOpen() ? event.touches[0].clientY : null;
  }, { passive: true });
  window.addEventListener("touchend", (event) => {
    if (pullStart !== null && current && !current.def.parent && event.changedTouches[0].clientY - pullStart > 80) {
      FA.board.invalidate();
      FA.refresh();
    }
    pullStart = null;
  }, { passive: true });

  document.addEventListener("DOMContentLoaded", () => {
    buildTabs();
    if (!FA.inTelegram) {
      const page = view();
      page.append(FA.empty("Откройте из Telegram", "Доска открывается кнопкой в чате с ботом."));
      tabBar.hidden = true;
      return;
    }
    const start = location.hash && screens[parse(location.hash).name] ? location.hash : "#board";
    if (location.hash !== start) history.replaceState(null, "", start);
    trail.push(start);
    // The first screen already says the bot's name: wait for the server's (one small read, cached after), but not
    // longer than a moment: a slow answer leaves the last known name rather than a blank page.
    const wait = new Promise((resolve) => setTimeout(resolve, 2000));
    Promise.race([FA.capabilities(), wait]).finally(() => show(start, false));
  });

  // Exposed for the tab bar's «already here» case: tapping the active tab scrolls to the top.
  document.addEventListener("click", (event) => {
    const tab = event.target.closest && event.target.closest(".tab");
    if (tab && tab.getAttribute("aria-current") === "page") {
      event.preventDefault();
      window.scrollTo({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", top: 0 });
    }
  });

})();
