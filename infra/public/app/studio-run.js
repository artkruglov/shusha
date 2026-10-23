// One Studio run (POST /app-api/studio, then GET /app-api/studio/<nonce> every 3 s): the v10 progress card
// «Шуша рисует…», then the picture, or a plain word that it failed. The nonce is the run: «Повторить» after
// a lost answer resends the same one and the server answers with the same run; «Ещё вариант» is a new run.
// The server also sends the picture to the chat and says when it got there (`delivered`); until then the
// page keeps reading. A re-POST of the same nonce and body never makes a second picture or a second message:
// the server resumes a stranded run or re-sends under the same delivery key.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;
  const QUIET_FAILURES = 3;

  /**
   * How long things may take: a read every `poll`; a finished picture not in the chat after `undelivered`
   * gets «Отправить в чат»; a run still «started» after `stale` is resumed once; after `giveUp` the page
   * stops reading and says it does not know. One object, so the timings can be tuned in one place.
   */
  FA.STUDIO_TIMING = { giveUp: 5 * 60000, poll: 3000, stale: 3.5 * 60000, undelivered: 20000 };

  const IN_CHAT = "Картинка уже в чате — ответьте там, если поправить.";
  const SENDING = "Отправляю в чат…";
  const STUCK = "Картинка готова и лежит в «Мои картинки». В чат ещё не дошла.";

  /**
   * `options`: { place, ctx, loader, payload: {recipe, note?, source?}, onEdit, source, compare, versions }:
   * `source` is the chosen photo (for «до / после» when `compare`), `versions` the visit's finished runs.
   * Draws into `place` and
   * returns a stop function (leaving the screen stops the reading; the run itself goes on at the server).
   */
  FA.studioRun = function studioRun(options) {
    const { place, ctx, loader } = options;
    const timing = FA.STUDIO_TIMING;
    let timer = null;
    let stopped = false;
    let run = null;

    function stop() {
      stopped = true;
      clearTimeout(timer);
    }

    function card(className) {
      const box = FA.card("studio-run " + className);
      place.replaceChildren(box);
      return box;
    }

    const post = () => FA.post("/app-api/studio", options.payload, run.nonce);

    function drawing() {
      const box = card("is-drawing");
      box.setAttribute("aria-live", "polite");
      box.append(FA.art("shusha-painter", "studio-run-art", true), el("h2", "studio-run-title", FA.Agent() + " рисует…"),
        el("p", "studio-run-text", "Обычно до минуты. Можно закрыть — пришлю в чат."));
      ctx.main.set(null);
    }

    /**
     * «До / после»: the source under the result, cut at a line the person moves. The line is a range input
     * (keyboard and screen readers work), its value goes to a CSS variable through the CSSOM.
     */
    function compareView(before, afterPath) {
      const box = el("div", "compare");
      box.style.setProperty("--cut", "50%");
      box.append(loader.thumb({ kind: "image", path: afterPath, scope: "personal" }, "compare-layer"));
      const beforeLayer = el("div", "compare-before");
      beforeLayer.append(loader.thumb(before, "compare-layer"));
      const line = el("span", "compare-line");
      const handle = el("span", "compare-handle");
      handle.append(FA.icon("chevron-left"), FA.icon("chevron-right"));
      line.append(handle);
      const range = el("input", "compare-range");
      range.type = "range";
      range.min = "0";
      range.max = "100";
      range.value = "50";
      range.setAttribute("aria-label", "До и после");
      const say = () => {
        const value = Number(range.value);
        range.setAttribute("aria-valuetext", value <= 3 ? "Только после" : value >= 97 ? "Только до" : "Слева до, справа после");
      };
      say();
      range.addEventListener("input", () => {
        box.style.setProperty("--cut", range.value + "%");
        say();
      });
      box.append(beforeLayer, line, el("span", "compare-tag is-before", "До"), el("span", "compare-tag is-after", "После"), range);
      return box;
    }

    /** The picture, drawn once per run; its line about the chat changes in place as delivery goes. */
    function result(path) {
      const versions = options.versions || [];
      if (!versions.some((version) => version.path === path)) versions.push({ path });
      const box = card("is-done");
      const stage = el("div", "studio-stage");
      const show = (chosenPath) => {
        if (options.compare && options.source) {
          stage.replaceChildren(compareView(options.source, chosenPath));
          return;
        }
        const big = loader.thumb({ kind: "image", path: chosenPath, scope: "personal" }, "studio-result");
        big.setAttribute("role", "img");
        big.setAttribute("aria-label", "Готовая картинка");
        stage.replaceChildren(big);
      };
      show(path);
      const status = el("div", "studio-run-status");
      status.setAttribute("aria-live", "polite");
      const links = el("div", "studio-run-links");
      links.append(button("link-button", "Изменить", options.onEdit), button("link-button", "Все картинки", () => FA.go("#media")));
      box.append(stage, el("h2", "studio-run-title", "Готово."), status);
      // Versions of this visit: every «Ещё вариант» adds one; a tap shows it (only on this screen, for now).
      if (versions.length > 1) {
        const strip = el("div", "version-strip");
        strip.setAttribute("role", "radiogroup");
        strip.setAttribute("aria-label", "Версии");
        versions.forEach((version, index) => {
          const pick = button("version-pick", "", () => {
            strip.querySelectorAll(".version-pick").forEach((node) => node.setAttribute("aria-checked", String(node === pick)));
            show(version.path);
          });
          pick.setAttribute("role", "radio");
          pick.setAttribute("aria-checked", String(version.path === path));
          pick.setAttribute("aria-label", "Версия " + (index + 1));
          pick.append(loader.thumb({ kind: "image", path: version.path, scope: "personal" }), el("span", "version-number", String(index + 1)));
          strip.append(pick);
        });
        box.append(el("p", "version-title", "Версии"), strip);
      }
      box.append(links);
      run.status = status;
      FA.haptic("success");
      ctx.main.set({ onClick: () => start(null), text: "Ещё вариант" });
    }

    function delivery(text, offerSend) {
      const line = el("p", "studio-run-text", text);
      run.status.replaceChildren(line);
      if (!offerSend) return;
      // The same nonce and body: the server re-sends under the same delivery key, so it cannot arrive twice.
      const send = button("secondary-button studio-send", "Отправить в чат", () => FA.busy(send, async () => {
        const errors = run.status.querySelector(".inline-error");
        if (errors) errors.remove();
        try {
          const state = await post();
          run.completedAt = Date.now();
          if (!settle(state)) poll(0);
        } catch (error) {
          FA.failed(error, run.status, () => send.click());
        }
      }));
      run.status.append(send);
    }

    function trouble(title, text) {
      const box = card("is-failed");
      box.setAttribute("role", "alert");
      box.append(FA.art("shusha-think", "studio-run-art"), el("h2", "studio-run-title", title), el("p", "studio-run-text", text));
      box.append(button("link-button", "Изменить", options.onEdit));
      FA.haptic("error");
      ctx.main.set({ onClick: () => start(null), text: "Попробовать ещё раз" });
    }

    const unsure = () => trouble("Не знаю, получилось ли.", "Загляните в чат: если картинки там нет, попробуйте ещё раз.");

    /** True when the run needs no more reading. */
    function settle(state) {
      if (stopped || !ctx.live()) return true;
      if (state.state === "completed" && state.path) {
        if (!run.status) result(state.path);
        if (state.delivered) {
          delivery(IN_CHAT, false);
          return true;
        }
        if (!run.completedAt) run.completedAt = Date.now();
        if (Date.now() - run.completedAt >= timing.undelivered) {
          delivery(STUCK, true);
          return true;
        }
        if (!run.status.querySelector(".studio-send")) delivery(SENDING, false);
        return false;
      }
      if (state.state === "failed") {
        trouble("Не получилось.", FA.Agent() + " не смогла нарисовать это. Попробуйте ещё раз или измените уточнение.");
        return true;
      }
      if (state.state === "ambiguous") {
        unsure();
        return true;
      }
      return false;
    }

    // Reading: a few failed reads in a row are quiet (the run goes on); after that the error shows with
    // «Повторить», which only resumes reading, never starts the run again.
    function poll(misses) {
      timer = setTimeout(async () => {
        if (stopped || !ctx.live()) return;
        // The cap is for a picture that never came; a finished one waiting for the chat keeps its own path.
        if (!run.status && Date.now() - run.startedAt >= timing.giveUp) {
          unsure();
          return;
        }
        let state;
        try {
          // A run «started» for too long may be stranded: the same POST once lets the server pick it up
          // again or settle it as ambiguous.
          const stale = !run.resumed && !run.status && Date.now() - run.startedAt >= timing.stale;
          if (stale) run.resumed = true;
          state = await (stale ? post() : FA.get("/app-api/studio/" + encodeURIComponent(run.nonce)));
        } catch (error) {
          if (misses + 1 < QUIET_FAILURES) {
            poll(misses + 1);
          } else if (!run.status) {
            const box = card("is-failed");
            box.append(FA.errorBox(error, () => {
              drawing();
              poll(0);
            }));
          } else {
            FA.failed(error, run.status, () => poll(0));
          }
          return;
        }
        if (!settle(state)) poll(0);
      }, timing.poll);
    }

    /** `nonce`: null for a new run, the same one for «Повторить» after a lost answer. */
    async function start(nonce) {
      stopped = false;
      clearTimeout(timer);
      if (!nonce) run = { nonce: FA.nonce(), startedAt: Date.now() };
      drawing();
      let state;
      try {
        state = await ctx.main.run(post);
      } catch (error) {
        if (!ctx.live()) return;
        const box = card("is-failed");
        // A limit or an unavailable model is not fixed by a retry; a network error is, with the same run.
        const retry = error.status === 429 || error.status === 503 || error.status === 400 ? null : () => start(run.nonce);
        box.append(FA.errorBox(error, retry), button("link-button", "Изменить", options.onEdit));
        FA.haptic("error");
        ctx.main.set(null);
        return;
      }
      if (!state) return;
      if (!settle(state)) poll(0);
    }

    start(null);
    return stop;
  };
})();
