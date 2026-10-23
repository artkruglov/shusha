// «Сегодня» (#board): a set of blocks that arrange themselves for this person. Each block shows only when it
// has something; overdue tasks, when there are any, stay first; the rest follow the order the person pinned
// or, without one, slowly follow what they use (home-prefs.js). «Настроить главную» shows or hides blocks,
// moves them, and puts everything back.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;

  const today0 = (iso) => new Date(iso + "T00:00:00Z").getUTCDay();

  function listCard(title, rows, go) {
    const card = FA.card("week-card home-list");
    card.append(el("h2", "card-title", title));
    const list = el("div", "week-list");
    rows.forEach((row) => {
      const node = button("week-row", "", () => FA.go(go));
      const mark = el("span", "avatar avatar-icon");
      mark.setAttribute("aria-hidden", "true");
      mark.append(FA.icon(row.icon));
      const text = el("span", "week-text");
      text.append(el("span", "week-when", row.when), FA.bdi(row.title, "week-title"));
      if (row.onlyMine) text.append(FA.onlyMineTag());
      node.append(mark, text, FA.icon("chevron-right", "nav-row-chevron"));
      list.append(node);
    });
    card.append(list);
    return card;
  }

  function navCard(options) {
    const card = FA.card("nav-card");
    card.append(FA.navRow(options));
    return card;
  }

  const sections = (data, kind) => data.board.sections.filter((section) => section.kind === kind);
  const waitingForMe = (data) => (data.family ? data.family.decisions.filter((d) => d.status === "open" && !d.isProposer && !d.answered) : []);
  const myTimeToday = (data) => (data.family ? data.family.time.mine.filter((w) => w.weekday === null || w.weekday === today0(data.board.today)) : []);
  const toBuy = (data) => (data.shopping ? data.shopping.items.filter((item) => !item.bought).length : 0);
  const closedCount = (data) => (data.closed ? data.closed.done.length + data.closed.cancelled.length : 0);

  function fold(data, kind) {
    const section = sections(data, kind)[0];
    if (!section) return null;
    // The chat's «Скажи…» hints point to the chat; here the rows themselves are the way in. «Разобрать» is the one-by-one
    // review of stale tasks, so the inbox of unplaced tasks is «Без места» (review of 21 October 2026).
    const title = kind === "unsorted" ? "Без места" : FA.plainTitle(section.title);
    return FA.boardParts.fold(kind, { rows: section.rows, title: title + " · " + section.rows.length });
  }

  // Default order; `on: false` blocks appear only when the person adds them. Overdue is not here: it goes right
  // after today when there is something overdue.
  const BLOCKS = [
    { build: (data) => (sections(data, "today")[0] ? FA.boardParts.todayCard(sections(data, "today")[0]) : null), id: "today", title: "Дела на сегодня" },
    {
      // v3: tasks unchanged for two weeks (carried on the board answer), one line and a way to answer them one by one.
      build: (data) => (data.board.stale && data.board.stale.length > 0 ? navCard({
        icon: "clock", onClick: () => FA.go("#review"),
        subtitle: FA.count(data.board.stale.length, FA.TASKS) + " не менялись две недели · разобрать по одному",
        title: "Давно без движения",
      }) : null),
      id: "stale", title: "Давно без движения",
    },
    { build: (data) => fold(data, "waiting"), id: "waiting", title: "Ждут вашего ответа" },
    { build: (data) => fold(data, "unowned"), id: "unowned", title: "Ничьи дела" },
    {
      build(data) {
        const projects = sections(data, "project");
        const stalled = sections(data, "stalled")[0];
        return projects.length > 0 || stalled ? FA.boardParts.projectsBlock(projects, stalled) : null;
      },
      id: "projects", title: "Проекты",
    },
    {
      build(data) {
        const items = waitingForMe(data);
        return items.length > 0 ? listCard("Решить вместе", items.map((d) => ({ icon: "scale", title: d.title, when: "Ждёт вашего ответа" })), "#decisions") : null;
      },
      id: "decisions", title: "Решить вместе",
    },
    {
      build(data) {
        const items = data.family ? data.family.traditions : [];
        return items.length > 0 ? listCard("Традиции", items.slice(0, 3).map((t) => ({
          icon: "heart", onlyMine: t.onlyMine, title: t.title,
          when: FA.traditionMarks(t, data.family).text || (t.last ? "Было " + t.last : "Ещё не было"),
        })), "#traditions") : null;
      },
      id: "traditions", title: "Традиции",
    },
    {
      build(data) {
        const items = myTimeToday(data);
        return items.length > 0 ? listCard("Ваше время сегодня", items.map((w) => ({
          icon: "clock", title: w.title, when: FA.clockText(w.startsAt) + "–" + FA.clockText(w.endsAt),
        })), "#time") : null;
      },
      id: "time", title: "Личное время",
    },
    {
      build: (data) => (toBuy(data) > 0 ? navCard({ icon: "cart", onClick: () => FA.go("#shopping"), subtitle: toBuy(data) + " в списке · открыть", title: "Покупки" }) : null),
      id: "shopping", title: "Покупки",
    },
    {
      build(data) {
        const rest = el("div", "fold-stack");
        ["unaccepted", "unsorted", "ideas"].forEach((kind) => {
          const box = fold(data, kind);
          if (box) rest.append(box);
        });
        return rest.childElementCount > 0 ? rest : null;
      },
      id: "rest", title: "Остальное с доски",
    },
    {
      build: (data) => (closedCount(data) > 0 ? navCard({ icon: "checkbox", onClick: () => FA.go("#closed"), subtitle: FA.count(closedCount(data), FA.TASKS), title: "Закрыто за неделю" }) : null),
      id: "closed", title: "Закрыто за неделю",
    },
    {
      build(data) {
        const holder = el("div");
        FA.recentTiles(holder, data.home && data.home.recent, data.loader);
        return holder.firstChild;
      },
      id: "pictures", on: false, title: "Картинки",
    },
  ];
  const IDS = BLOCKS.map((block) => block.id);
  const byId = (id) => BLOCKS.find((block) => block.id === id);
  const shown = (prefs, block) => (block.on === false ? prefs.on.includes(block.id) : !prefs.off.includes(block.id));

  /** The hero's line follows the first block: tasks in words, or what the person keeps on top. */
  function sentence(first, data) {
    const words = { 1: "одно", 2: "два", 3: "три", 4: "четыре" };
    if (first === "decisions") {
      const n = waitingForMe(data).length;
      return n === 1 ? "Одно решение ждёт вашего ответа." : (words[n] || n) + " решения ждут вашего ответа.";
    }
    if (first === "traditions") return "Традиция этой недели — " + data.family.traditions[0].title + ".";
    if (first === "time") return "Сегодня ваше время: " + myTimeToday(data).map(FA.windowShort).map((t) => t.replace(/^\S+ /u, "")).join(", ") + ".";
    if (first === "shopping") return "В покупках " + toBuy(data) + ".";
    if (first === "closed") return "За неделю закрыто " + FA.count(closedCount(data), FA.TASKS) + ".";
    return FA.daySentence(data.board);
  }

  /** «Настроить главную»: show or hide each block, move it, or put everything back. */
  function settings(prefs, order) {
    let changed = false;
    const sheet = FA.openSheet({
      build(body) {
        body.append(el("p", "sheet-text", "Просроченные дела всегда сверху. Остальное " + FA.agent() + " расставляет по тому, чем вы пользуетесь, — или так, как вы поставите."));
        const list = el("div", "home-settings");
        const draw = () => {
          list.replaceChildren();
          order.forEach((id, index) => {
            const block = byId(id);
            const row = FA.switchRow({
              checked: shown(prefs, block),
              label: block.title,
              onChange(on) {
                changed = true;
                prefs.off = prefs.off.filter((x) => x !== id);
                prefs.on = prefs.on.filter((x) => x !== id);
                if (block.on === false && on) prefs.on.push(id);
                if (block.on !== false && !on) prefs.off.push(id);
                FA.homePrefs.save(prefs);
              },
            });
            const move = (step) => {
              const to = index + step;
              if (to < 0 || to >= order.length) return;
              [order[index], order[to]] = [order[to], order[index]];
              prefs.pin = order.slice();
              changed = true;
              FA.homePrefs.save(prefs);
              draw();
              const again = list.querySelectorAll(".home-move")[to * 2 + (step < 0 ? 0 : 1)];
              if (again) again.focus();
            };
            const up = button("icon-button home-move", "", () => move(-1));
            up.setAttribute("aria-label", "Выше: " + block.title);
            up.append(FA.icon("chevron-left", "home-move-icon is-up"));
            up.disabled = index === 0;
            const down = button("icon-button home-move", "", () => move(1));
            down.setAttribute("aria-label", "Ниже: " + block.title);
            down.append(FA.icon("chevron-left", "home-move-icon is-down"));
            down.disabled = index === order.length - 1;
            row.row.append(up, down);
            list.append(row.row);
          });
        };
        draw();
        const reset = button("secondary-button wide", "Как было", () => {
          const fresh = FA.homePrefs.reset();
          Object.assign(prefs, fresh);
          changed = true;
          sheet.close();
          FA.toast("Главная как была");
        });
        body.append(list, reset);
      },
      onClose() {
        if (changed) FA.refresh();
      },
      title: "Настроить главную",
    });
  }

  FA.screen("board", {
    parent: null,
    tab: "board",
    title: "Сегодня",
    async render(view, _arg, ctx) {
      const visit = view.classList.contains("is-entering");
      const [board, home, family, shopping, closed, prefs] = await FA.load(view, () => Promise.all([
        FA.board.get(true),
        FA.get("/app-api/home").catch(() => null),
        FA.family.get(true).catch(() => null),
        FA.get("/app-api/shopping").catch(() => null),
        FA.get("/app-api/closed").catch(() => null),
        FA.homePrefs.load().catch(() => null),
      ]), "Загружаю дела…");
      const loader = FA.previewLoader();
      const data = { board, closed, family, home, loader, shopping };
      const settled = prefs || { last: [], off: [], on: [], pin: null, s: {}, saved: 0, v: 1 };
      // Build every shown block once; the order then only places them.
      const built = new Map();
      BLOCKS.forEach((block) => {
        if (!shown(settled, block)) return;
        const node = block.build(data);
        if (node) built.set(block.id, node);
      });
      const order = FA.homePrefs.arrange(settled, IDS, visit, new Set(built.keys()));
      if (visit) FA.homePrefs.save(settled);

      // Build first, so the hero can speak about what comes first.
      const blocks = [];
      order.forEach((id) => {
        if (built.has(id)) blocks.push({ id, node: built.get(id) });
      });
      // The overdue fold right after today, not above it: the morning starts with what is doable today, not a
      // reproach (review of 21 October 2026, as the chat board v3).
      const overdue = sections(data, "overdue")[0];
      if (overdue) {
        const rows = overdue.rows.map((row) => ({ ...row, detail: FA.boardParts.overdueDetail(row.detail, board.today) }));
        const at = blocks.findIndex((block) => block.id === "today");
        blocks.splice(at + 1, 0, { id: "overdue", node: FA.boardParts.fold("overdue", {
          danger: true, rows, summary: overdue.rows.slice(0, 3).map((row) => row.title).join(", "),
          title: FA.plainTitle(overdue.title) + " · " + overdue.rows.length,
        }) });
      }
      const header = FA.homeHero(view, board, home, blocks.length === 0 ? null : sentence(blocks[0].id, data));
      // The first-steps ring sits on the hero, outside the blocks: it helps once and must not push the day down.
      if (home && home.quest && FA.questPill) FA.questPill(header, home.quest);

      if (blocks.length === 0) view.append(FA.empty("Сегодня свободно. Можно отдохнуть.", "Я рядом, если что-то понадобится."));
      const jumps = [];
      const LABELS = { overdue: "Просрочено", today: "Сегодня", unowned: "Ничьи", waiting: "Жду" };
      blocks.forEach((block) => {
        const wrap = el("div", "home-block");
        wrap.dataset.block = block.id;
        wrap.append(block.node);
        // A tap on anything in the block is a use of it; that is all that is counted.
        wrap.addEventListener("click", (event) => {
          if (event.target.closest("button, a, input")) FA.homePrefs.use(settled, block.id);
        });
        view.append(wrap);
        if (LABELS[block.id]) {
          const section = sections(data, block.id)[0];
          jumps.push({ box: block.node, count: section ? section.rows.length : 0, danger: block.id === "overdue", label: LABELS[block.id] });
        }
      });
      if (jumps.length > 1) header.after(FA.boardParts.jumpStrip(jumps));
      const tune = button("link-button home-tune", "Настроить главную", () => settings(settled, order.slice()));
      view.append(tune);
      const stopAsk = FA.askBar(view, ctx, () => FA.refresh());
      return () => {
        loader.revoke();
        stopAsk();
      };
    },
  });
})();
