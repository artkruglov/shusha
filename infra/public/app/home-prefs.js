// How «Сегодня» arranges itself for this person: which blocks they hide or add, an order they pinned, and
// what they actually use. Only block ids, decayed counts and timestamps are kept — never a task title or
// anything else people wrote. The record lives in Telegram's CloudStorage (per person and bot, the same on
// every device), with localStorage as a cache and a fallback; any failure means the default layout.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const KEY = "home.v1";
  const MAX_CHARS = 4096;
  const HALF_LIFE_DAYS = 14;
  const TAPS_PER_VISIT = 3;
  const ID = /^[a-z]{2,16}$/u;

  const now = () => Math.floor(Date.now() / 1000);
  const fresh = () => ({ last: [], off: [], on: [], pin: null, s: {}, saved: 0, v: 1 });

  /** Only what we wrote ourselves gets in: ids of the right shape, finite numbers. */
  function clean(raw) {
    const prefs = fresh();
    if (!raw || typeof raw !== "object" || raw.v !== 1) return prefs;
    const ids = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === "string" && ID.test(id)).slice(0, 32) : []);
    prefs.last = ids(raw.last);
    prefs.off = ids(raw.off);
    prefs.on = ids(raw.on);
    prefs.pin = Array.isArray(raw.pin) ? ids(raw.pin) : null;
    prefs.saved = Number.isFinite(raw.saved) ? raw.saved : 0;
    if (raw.s && typeof raw.s === "object") {
      Object.keys(raw.s).forEach((id) => {
        const entry = raw.s[id];
        if (ID.test(id) && Array.isArray(entry) && Number.isFinite(entry[0]) && Number.isFinite(entry[1])) prefs.s[id] = [entry[0], entry[1]];
      });
    }
    return prefs;
  }

  const parse = (text) => {
    try {
      return text ? clean(JSON.parse(text)) : null;
    } catch (_) {
      return null;
    }
  };

  function cloud() {
    try {
      const tg = FA.tg;
      return tg && tg.CloudStorage && typeof tg.isVersionAtLeast === "function" && tg.isVersionAtLeast("6.9") ? tg.CloudStorage : null;
    } catch (_) {
      return null;
    }
  }

  /** CloudStorage answers by callback, sometimes not at all on old clients: a short wait, then without it. */
  function readCloud() {
    const store = cloud();
    if (!store) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1500);
      try {
        store.getItem(KEY, (error, value) => {
          clearTimeout(timer);
          resolve(error ? null : parse(value));
        });
      } catch (_) {
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  function readLocal() {
    try {
      return parse(localStorage.getItem(KEY));
    } catch (_) {
      return null;
    }
  }

  /** A day's score falls to half in two weeks: what is used now outweighs what was used a month ago. */
  function score(prefs, id, at) {
    const entry = prefs.s[id];
    if (!entry) return 0;
    return entry[0] * Math.pow(0.5, Math.max(0, at - entry[1]) / (HALF_LIFE_DAYS * 86400));
  }

  let taps = {};
  let saveTimer = null;

  FA.homePrefs = {
    /** The newer of the cloud record and the local copy; the default when neither can be read. */
    async load() {
      taps = {};
      const [remote, local] = await Promise.all([readCloud(), Promise.resolve(readLocal())]);
      if (remote && (!local || remote.saved >= local.saved)) return remote;
      return local || fresh();
    },

    save(prefs) {
      prefs.saved = now();
      // Within CloudStorage's 4096 characters: the weakest scores go first if it ever grows that far.
      let text = JSON.stringify(prefs);
      while (text.length > MAX_CHARS && Object.keys(prefs.s).length > 0) {
        const weakest = Object.keys(prefs.s).sort((a, b) => score(prefs, a, prefs.saved) - score(prefs, b, prefs.saved))[0];
        delete prefs.s[weakest];
        text = JSON.stringify(prefs);
      }
      try {
        localStorage.setItem(KEY, text);
      } catch (_) { /* storage may be blocked */ }
      const store = cloud();
      try {
        if (store) store.setItem(KEY, text, () => {});
      } catch (_) { /* the local copy stays */ }
    },

    /** A tap inside a block: one more use, at most a few per visit so one busy visit does not decide. */
    use(prefs, id) {
      taps[id] = (taps[id] || 0) + 1;
      if (taps[id] > TAPS_PER_VISIT) return;
      const at = now();
      prefs.s[id] = [score(prefs, id, at) + 1, at];
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => FA.homePrefs.save(prefs), 800);
    },

    /**
     * The order of the blocks: the pinned one if the person set it; otherwise the last shown order with at
     * most one block moved one place up per visit, towards what is used more. `ids` is the default order,
     * `visible` the blocks that have something to show today.
     */
    arrange(prefs, ids, visit, visible) {
      const known = new Set(ids);
      const base = (prefs.pin || prefs.last).filter((id) => known.has(id));
      ids.forEach((id, index) => {
        if (!base.includes(id)) base.splice(Math.min(index, base.length), 0, id);
      });
      if (!prefs.pin && visit) {
        // Only blocks on the screen trade places: a step past a hidden or empty block would change nothing.
        const at = now();
        const places = base.map((id, index) => index).filter((index) => !visible || visible.has(base[index]));
        let best = -1;
        let gain = 0.5;
        for (let i = 1; i < places.length; i += 1) {
          const difference = score(prefs, base[places[i]], at) - score(prefs, base[places[i - 1]], at);
          if (difference > gain) {
            gain = difference;
            best = i;
          }
        }
        if (best > 0) {
          const [a, b] = [places[best - 1], places[best]];
          [base[a], base[b]] = [base[b], base[a]];
        }
      }
      prefs.last = base;
      return base;
    },

    reset() {
      const prefs = fresh();
      FA.homePrefs.save(prefs);
      return prefs;
    },
  };
})();
