// «Мои картинки и файлы» (#media): what the bot made, as a showcase. Making things stays in the chat (the
// model, payment and confirmations live there); from here a file goes back into the chat: «Отправить в чат»,
// or with a caption for «Сделать вариант» / «Оживить в видео», which the person answers there.
// Previews need the signed header, so they are fetched as blobs and shown through object URLs, lazily,
// a few at a time; every URL is revoked when the screen goes, and the bytes stay for the next screen.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;
  const PARALLEL = 4;
  // Previews already fetched in this opening of the app, newest last: a redraw or another screen shows them
  // at once instead of fetching them again. Only a file's own bytes, never its URL (each screen makes its own).
  const BLOBS_MAX_BYTES = 12 * 1024 * 1024;
  const blobs = new Map();
  let blobBytes = 0;

  function keep(key, blob) {
    if (blobs.has(key)) blobBytes -= blobs.get(key).size;
    blobs.delete(key);
    blobs.set(key, blob);
    blobBytes += blob.size;
    for (const [oldKey, old] of blobs) {
      if (blobBytes <= BLOBS_MAX_BYTES || oldKey === key) break;
      blobs.delete(oldKey);
      blobBytes -= old.size;
    }
  }

  const previewPath = (file) => "/app-api/files/preview?scope=" + encodeURIComponent(file.scope) + "&path=" + encodeURIComponent(file.path);
  const keyOf = (file) => file.scope + "\n" + file.path;

  /** «16 октября», in the device's zone (files carry a moment, not a day). */
  FA.shortDate = function shortDate(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(date);
  };

  function sizeText(bytes) {
    if (!Number.isFinite(bytes)) return "";
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " КБ";
    return (bytes / (1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " МБ";
  }

  /**
   * One loader per screen: previews start when their tile comes near the viewport, at most four at once,
   * each file once. `revoke()` frees every object URL and stops what is still waiting.
   */
  FA.previewLoader = function previewLoader() {
    const urls = new Map();
    const queue = [];
    const watched = new Map();
    let active = 0;
    let gone = false;

    function pump() {
      while (!gone && active < PARALLEL && queue.length > 0) {
        const job = queue.shift();
        active += 1;
        FA.getBlob(previewPath(job.file))
          .then((blob) => {
            keep(keyOf(job.file), blob);
            return URL.createObjectURL(blob);
          })
          .then(job.resolve, job.reject)
          .finally(() => {
            active -= 1;
            pump();
          });
      }
    }

    /** The object URL at once when this opening already has the bytes, otherwise null. */
    function cached(file) {
      const key = keyOf(file);
      const blob = blobs.get(key);
      if (!blob || urls.has(key)) return null;
      const url = URL.createObjectURL(blob);
      urls.set(key, Promise.resolve(url));
      return url;
    }

    function load(file) {
      const key = keyOf(file);
      const ready = cached(file);
      if (ready) return Promise.resolve(ready);
      if (!urls.has(key)) urls.set(key, new Promise((resolve, reject) => {
        queue.push({ file, reject, resolve });
        pump();
      }));
      return urls.get(key);
    }

    function show(holder, file) {
      const img = holder.querySelector("img");
      load(file).then((url) => {
        if (gone) return;
        img.src = url;
        img.addEventListener("load", () => holder.classList.add("is-loaded"), { once: true });
      }, () => {
        if (!gone) holder.classList.add("is-failed");
      });
    }

    const observer = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        const file = watched.get(entry.target);
        watched.delete(entry.target);
        if (file) show(entry.target, file);
      });
    }, { rootMargin: "200px 0px" }) : null;

    return {
      /** A tile: a calm placeholder with an icon until the picture arrives, and after an error. */
      thumb(file, className) {
        const holder = el("span", "thumb" + (className ? " " + className : ""));
        holder.append(FA.icon("image", "thumb-icon"));
        const img = el("img");
        img.alt = "";
        img.decoding = "async";
        holder.append(img);
        const ready = cached(file);
        if (ready) {
          // Seen before: no placeholder and no fade, so a redraw does not blink.
          img.src = ready;
          holder.classList.add("is-loaded");
        } else if (observer) {
          watched.set(holder, file);
          observer.observe(holder);
        } else {
          show(holder, file);
        }
        return holder;
      },
      load,
      /** A photo just sent from the phone: show the local copy at once, no second download. */
      seed(file, blob) {
        const key = keyOf(file);
        keep(key, blob);
        if (!urls.has(key)) urls.set(key, Promise.resolve(URL.createObjectURL(blob)));
      },
      revoke() {
        gone = true;
        queue.length = 0;
        if (observer) observer.disconnect();
        urls.forEach((promise) => promise.then((url) => URL.revokeObjectURL(url), () => {}));
        urls.clear();
      },
    };
  };

  /** Where a picture came from: a photo the person sent from the phone, or one Шуша made. */
  FA.sourceBadge = function sourceBadge(file, className) {
    const phone = String(file.path).startsWith("photos/");
    return el("span", "source-badge" + (phone ? " is-phone" : "") + (className ? " " + className : ""), phone ? "С телефона" : FA.Agent());
  };

  const KINDS = [["image", "Картинки"], ["video", "Видео"], ["document", "Документы"]];
  const DONE = { animate: "Отправил в чат — ответьте там, что изменить", send: "Отправил в чат", variant: "Отправил в чат — ответьте там, что изменить" };

  /** The file's sheet: a larger preview for a picture, and what can be done with it from here. */
  function fileSheet(file, loader, caps) {
    const image = file.kind === "image";
    // One nonce per action and file while the sheet is open: «Повторить» resends the same request.
    const nonces = {};
    const actions = [["send", "send", "Отправить в чат"]];
    if (image && caps.images) actions.push(["variant", "wand", "Сделать вариант"]);
    if (image && caps.video) actions.push(["animate", "film", "Оживить в видео"]);
    const errors = el("div");
    const sheet = FA.openSheet({
      build(body) {
        if (image) {
          const big = loader.thumb(file, "thumb-large");
          big.setAttribute("role", "img");
          big.setAttribute("aria-label", "Картинка от " + FA.shortDate(file.at));
          body.append(big);
          if (file.caption) body.append(FA.bdi(file.caption, "sheet-text media-caption-full"));
        } else {
          body.append(FA.bdi(file.caption || file.name, "sheet-text media-name"));
        }
        const list = el("div", "card nav-card media-actions");
        actions.forEach(([purpose, icon, label]) => {
          const row = FA.navRow({ icon, onClick: () => send(purpose, row), title: label });
          row.querySelector(".nav-row-chevron").remove();
          list.append(row);
        });
        body.append(list, errors);
      },
      title: image ? "Картинка от " + FA.shortDate(file.at) : file.kind === "video" ? "Видео" : "Документ",
    });

    async function send(purpose, row) {
      if (!nonces[purpose]) nonces[purpose] = FA.nonce();
      errors.replaceChildren();
      FA.lockForm(sheet.body, true);
      try {
        await FA.busy(row, () => FA.post("/app-api/files/send", { path: file.path, purpose, scope: file.scope }, nonces[purpose]));
      } catch (error) {
        FA.lockForm(sheet.body, false);
        FA.failed(error, errors, () => send(purpose, row));
        return;
      }
      FA.haptic("success");
      const done = el("div", "media-done");
      done.setAttribute("role", "status");
      done.append(FA.icon("check-circle", "added-icon"), el("p", null, DONE[purpose]));
      const buttons = el("div", "media-done-buttons");
      if (FA.tg && typeof FA.tg.close === "function") buttons.append(button("primary-button", "Открыть чат", () => FA.tg.close()));
      buttons.append(button("secondary-button", "Готово", () => sheet.close()));
      done.append(buttons);
      sheet.body.querySelector(".media-actions").replaceWith(done);
      const first = done.querySelector("button");
      if (first) first.focus();
    }
  }

  // «Шуша сделала за вас» on «Сегодня» opens the same sheet.
  FA.fileSheet = fileSheet;

  function emptyState(text) {
    const box = FA.empty(text, null, "sleep");
    box.append(button("link-button", "Что я умею", () => FA.go("#skills")));
    return box;
  }

  FA.screen("media", {
    parent: "#more",
    parentLabel: "Ещё",
    tab: "more",
    title: "Мои картинки и файлы",
    async render(view) {
      FA.header(view, { shusha: "shusha-painter", subtitle: "Придумали вместе с " + FA.agent("instrumental"), title: "Мои картинки и файлы" });
      const loader = FA.previewLoader();
      let data;
      let caps;
      try {
        [data, caps] = await FA.load(view, () => Promise.all([FA.get("/app-api/files"), FA.capabilities()]));
      } catch (error) {
        loader.revoke();
        throw error;
      }
      const files = data.files;
      if (files.length === 0) {
        view.append(emptyState("Здесь появятся картинки, видео и документы, которые сделает бот"));
        return () => loader.revoke();
      }
      const of = (kind) => files.filter((file) => file.kind === kind);
      const body = el("div");
      // «Найти по описанию»: what was asked for a picture, or the name when there is none. Only pictures made
      // since captions exist have one, so the field appears only when something can be found by it.
      const search = el("div", "search");
      const query = el("input", "search-input");
      query.type = "search";
      query.placeholder = "Найти по описанию";
      query.setAttribute("aria-label", "Найти по описанию");
      search.append(FA.icon("search", "search-icon"), query);
      search.hidden = !files.some((file) => file.caption);
      const matches = (file) => {
        const text = query.value.trim().toLocaleLowerCase("ru");
        return !text || (file.caption || file.name).toLocaleLowerCase("ru").indexOf(text) !== -1;
      };
      query.addEventListener("input", () => draw(kinds.value()));
      const kinds = FA.radioGroup({
        labelledBy: null,
        onChange: (kind) => { FA.uiSet("media.kind", kind); draw(kind); },
        options: KINDS.map(([kind, label]) => [kind, of(kind).length > 0 ? label + " " + of(kind).length : label]),
        value: FA.uiGet("media.kind", of("image").length > 0 ? "image" : files[0].kind),
      });
      kinds.node.setAttribute("aria-label", "Что показать");
      kinds.node.classList.add("media-kinds");
      view.append(search, kinds.node, body);

      function draw(kind) {
        body.replaceChildren();
        const all = of(kind);
        if (all.length === 0) {
          body.append(emptyState(kind === "image" ? "Картинок пока нет" : kind === "video" ? "Видео пока нет" : "Документов пока нет"));
          return;
        }
        const items = all.filter(matches);
        if (items.length === 0) {
          body.append(el("p", "status", "Ничего не нашлось. Описание есть только у новых картинок."));
          return;
        }
        if (kind === "image") {
          const grid = el("ul", "media-grid");
          items.forEach((file) => {
            const item = el("li");
            const tile = button("media-tile", "", () => fileSheet(file, loader, caps));
            const date = FA.shortDate(file.at);
            tile.setAttribute("aria-label", (file.caption ? file.caption + ". " : "") + "Картинка от " + date + (file.scope === "family" ? ", семейная" : ""));
            const meta = el("span", "media-meta");
            meta.append(el("span", null, date));
            if (file.scope === "family") meta.append(el("span", "tag", "Семья"));
            if (String(file.path).startsWith("photos/")) meta.append(el("span", "tag", "С телефона"));
            tile.append(loader.thumb(file));
            if (file.caption) tile.append(FA.bdi(file.caption, "media-caption"));
            tile.append(meta);
            item.append(tile);
            grid.append(item);
          });
          body.append(grid);
          return;
        }
        const card = FA.card("nav-card");
        items.forEach((file) => {
          const row = FA.navRow({
            icon: kind === "video" ? "film" : "file",
            onClick: () => fileSheet(file, loader, caps),
            subtitle: [FA.shortDate(file.at), sizeText(file.size), file.scope === "family" ? "Семья" : null].filter(Boolean).join(" · "),
            title: file.caption || file.name,
          });
          row.querySelector(".nav-row-title").dir = "auto";
          card.append(row);
        });
        body.append(card);
      }
      draw(kinds.value());
      return () => loader.revoke();
    },
  });
})();
