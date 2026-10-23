// The board's parts: the shared task row, folded sections, «Сегодня», projects, the jump strip. The server's
// sections arrive in the chat board's order and kinds; «Сегодня» (home-blocks.js) arranges them as blocks.
// A row draws only the buttons its `actions` name; whether the person may, the task repository decides.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;
  const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** «Готово: … · Вернуть» for five seconds; a repeated task moves to its next date, so it has no «Вернуть». */
  FA.doneToast = function doneToast(title, task, repeat) {
    if (repeat || !task || task.status !== "completed") {
      FA.toast("Готово: " + title);
      return;
    }
    const undoNonce = FA.nonce();
    FA.toast("Готово: " + title, {
      action: {
        label: "Вернуть",
        async run() {
          try {
            await FA.taskAction(task.id, "reopen", task.version, null, undoNonce);
            FA.board.invalidate();
            FA.toast("Дело возвращено");
            FA.refresh();
          } catch (error) {
            FA.failed(error);
          }
        },
      },
    });
  };

  const SAID = {
    accept: "Принято: ",
    claim: "Теперь это ваше: ",
    decline: "Автор узнает, что вы не можете: ",
  };

  /**
   * One task row: the text opens the card, the control on the right closes it (or takes it, for an unowned
   * task: the guide shows no «Сделано» before someone takes it). Neighbouring buttons, never nested.
   */
  FA.taskRow = function taskRow(row, onChanged) {
    const item = el("li", "task-row");
    const body = el("div", "task-body");
    const open = row.id
      ? button("task-open", "", () => FA.go("#task/" + encodeURIComponent(row.id)))
      : el("div", "task-open");
    open.append(FA.bdi(row.title, "task-title"));
    if (row.detail || row.repeat) {
      const meta = el("span", "task-meta");
      if (row.repeat) meta.append(FA.icon("repeat", "meta-icon"));
      meta.append(el("span", null, row.repeat ? (row.detail ? "Повторяется · " + row.detail : "Повторяется") : row.detail));
      open.append(meta);
    }
    body.append(open);
    item.append(body);
    if (!row.id) return item;
    const has = (action) => row.actions.indexOf(action) !== -1;
    const after = onChanged || (() => FA.refresh());

    // A retry repeats the same operation with the same nonce; only a new tap starts a new one.
    async function act(action, control, nonce) {
      await FA.busy(control, async () => {
        try {
          await FA.taskAction(row.id, action, row.version, null, nonce);
          FA.haptic("success");
          FA.board.invalidate();
          FA.toast(SAID[action] + row.title);
          after();
        } catch (error) {
          FA.failed(error, body, () => act(action, control, nonce));
        }
      });
    }

    if (has("accept")) {
      const bar = el("div", "task-actions");
      const take = button("pill", "Беру", () => act("accept", take, FA.nonce()));
      take.setAttribute("aria-label", "Беру: " + row.title);
      bar.append(take);
      if (has("decline")) {
        const no = button("pill pill-quiet", "Не могу", () => act("decline", no, FA.nonce()));
        no.setAttribute("aria-label", "Не могу: " + row.title);
        bar.append(no);
      }
      body.append(bar);
    } else if (has("claim")) {
      const take = button("pill side-pill", "Беру", () => act("claim", take, FA.nonce()));
      take.setAttribute("aria-label", "Беру: " + row.title);
      item.append(take);
    } else if (has("complete")) {
      const complete = (nonce) => FA.busy(check, async () => {
        try {
          const { task } = await FA.taskAction(row.id, "complete", row.version, null, nonce);
          FA.haptic("success");
          item.classList.add("is-done");
          check.setAttribute("aria-checked", "true");
          FA.board.invalidate();
          FA.doneToast(row.title, task, row.repeat);
          // A moment for the eye to see the tick before the row leaves its section.
          setTimeout(after, reducedMotion() ? 0 : 350);
        } catch (error) {
          FA.failed(error, body, () => complete(nonce));
        }
      });
      const check = button("check", "", () => complete(FA.nonce()));
      check.setAttribute("role", "checkbox");
      check.setAttribute("aria-checked", "false");
      check.setAttribute("aria-label", "Сделано: " + row.title);
      check.append(FA.icon("check", "check-mark"));
      item.append(check);
      revealOnSwipe(item, body, () => complete(FA.nonce()), row.title);
    }
    return item;
  };

  /**
   * v3: a swipe to the left only reveals «Сделано» beside the row (style guide §4.1); the round control stays the
   * way to close, and a vertical scroll never counts as a swipe. A tap anywhere else hides it again.
   */
  const SWIPE_PX = 48;
  function revealOnSwipe(item, body, complete, title) {
    const done = button("pill swipe-done", "Сделано", () => {
      item.classList.remove("is-swiped");
      complete();
    });
    done.setAttribute("aria-label", "Сделано: " + title);
    done.tabIndex = -1;
    body.append(done);
    let start = null;
    item.addEventListener("touchstart", (event) => {
      const touch = event.touches[0];
      start = touch ? { x: touch.clientX, y: touch.clientY } : null;
    }, { passive: true });
    item.addEventListener("touchmove", (event) => {
      const touch = event.touches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dy) > Math.abs(dx)) {
        start = null;
        return;
      }
      if (dx < -SWIPE_PX) {
        start = null;
        item.classList.add("is-swiped");
        FA.haptic("select");
      } else if (dx > SWIPE_PX) {
        start = null;
        item.classList.remove("is-swiped");
      }
    }, { passive: true });
  }
  // One listener for every row, not one per row: rows are redrawn often.
  document.addEventListener("click", (event) => {
    document.querySelectorAll(".task-row.is-swiped").forEach((open) => {
      if (!open.contains(event.target)) open.classList.remove("is-swiped");
    });
  });

  /** «3 из 5», «Нет дел», or the open count for a list without a project; the line only for a real total. */
  FA.projectCount = function projectCount(section) {
    const p = section.project || section.progress;
    if (p) return p.total === 0 ? { text: "Нет дел" } : { completed: p.completed, text: p.completed + " из " + p.total, total: p.total };
    return { text: FA.count(section.rows.length, ["открытое", "открытых", "открытых"]) };
  };

  /** The thin accent line: width only, never a percentage in words (guide §5, v2 README). */
  FA.progressLine = function progressLine(count) {
    const line = el("div", "progress");
    line.setAttribute("aria-hidden", "true");
    const fill = el("span");
    fill.style.width = Math.min(100, Math.round((100 * count.completed) / count.total)) + "%";
    line.append(fill);
    return line;
  };

  FA.rowList = function rowList(rows, hint, onChanged) {
    const list = el("ul", "task-list");
    rows.forEach((row) => list.append(FA.taskRow(row, onChanged)));
    if (hint) list.append(el("li", "task-hint", hint));
    return list;
  };

  let foldCount = 0;
  /** A folded section: one full-width button with a chevron and aria-expanded; the state survives a return. */
  function fold(key, options) {
    foldCount += 1;
    const box = FA.card("fold" + (options.danger ? " fold-danger" : ""));
    const toggle = button("fold-toggle");
    if (options.danger) toggle.append(FA.icon("warning", "fold-icon"));
    const text = el("span", "fold-text");
    text.append(el("span", "fold-title", options.title));
    const summary = options.summary ? el("span", "fold-summary", options.summary) : null;
    if (summary) text.append(summary);
    toggle.append(text, FA.icon("chevron-right", "fold-chevron"));
    const list = FA.rowList(options.rows, options.hint);
    list.id = "fold-" + foldCount;
    toggle.setAttribute("aria-controls", list.id);
    function paint(open) {
      toggle.setAttribute("aria-expanded", String(open));
      list.hidden = !open;
      if (summary) summary.hidden = open;
    }
    paint(FA.uiGet("fold." + key, false));
    toggle.addEventListener("click", () => {
      const open = list.hidden;
      paint(open);
      FA.uiSet("fold." + key, open);
    });
    box.append(toggle, list);
    // For the jump strip: open the section if it is folded.
    box.expand = () => {
      if (list.hidden) toggle.click();
    };
    return box;
  }

  function todayCard(section) {
    const box = FA.card("today");
    const head = el("div", "card-head");
    head.append(el("h2", "card-title", section ? "Сегодня · " + section.rows.length : "Сегодня · 0"));
    if (section && section.rows.some((row) => row.actions.indexOf("complete") !== -1)) {
      head.append(button("link-button card-head-link", "Отметить", () => FA.go("#mark-done")));
    }
    box.append(head);
    if (!section) {
      const quiet = el("div", "card-empty");
      quiet.append(el("p", "card-empty-title", "Дел на сегодня нет"));
      quiet.append(el("p", "card-empty-text", "Можно посмотреть другие дни или добавить новое дело."));
      box.append(quiet);
      return box;
    }
    const SHOWN = 3;
    const list = FA.rowList(section.rows.slice(0, SHOWN));
    box.append(list);
    if (section.rows.length > SHOWN) {
      const rest = FA.rowList(section.rows.slice(SHOWN));
      rest.id = "today-rest";
      rest.classList.add("task-list-rest");
      const all = button("card-more");
      all.setAttribute("aria-controls", rest.id);
      const paint = (open) => {
        rest.hidden = !open;
        all.textContent = open ? "Свернуть" : "Ещё " + (section.rows.length - SHOWN);
        all.setAttribute("aria-expanded", String(open));
      };
      paint(FA.uiGet("today.more", false));
      all.addEventListener("click", () => {
        const open = rest.hidden;
        paint(open);
        FA.uiSet("today.more", open);
      });
      box.append(rest, all);
      box.expand = () => {
        if (rest.hidden) all.click();
      };
    }
    return box;
  }

  /** One project: name, «3 из 5», the line; a real project opens its page, a plain list shows its tasks right there. */
  function projectItem(section) {
    const item = el("li", "project-item");
    const key = "project." + (section.project ? section.project.id : section.title);
    const toggle = button("project-toggle");
    const count = FA.projectCount(section);
    const top = el("span", "project-top");
    top.append(FA.bdi(section.title, "project-name"), el("span", "project-count", count.text));
    toggle.append(top);
    if (count.total) toggle.append(FA.progressLine(count));
    toggle.append(FA.icon("chevron-right", "fold-chevron"));
    if (section.project) {
      toggle.addEventListener("click", () => FA.go("#project/" + encodeURIComponent(section.project.id)));
      item.append(toggle);
      return item;
    }
    const list = FA.rowList(section.rows);
    list.id = "pj-" + Math.random().toString(36).slice(2);
    toggle.setAttribute("aria-controls", list.id);
    const paint = (open) => {
      toggle.setAttribute("aria-expanded", String(open));
      list.hidden = !open;
    };
    paint(FA.uiGet("fold." + key, false));
    toggle.addEventListener("click", () => {
      const open = list.hidden;
      paint(open);
      FA.uiSet("fold." + key, open);
    });
    item.append(toggle, list);
    return item;
  }

  function projectsBlock(projects, stalled) {
    const block = el("section", "board-block");
    const head = el("div", "block-head");
    head.append(FA.sectionTitle("Проекты"));
    head.append(button("link-button", "Все проекты", () => FA.go("#projects")));
    block.append(head);
    const card = FA.card("projects-card");
    const list = el("ul", "project-list");
    projects.forEach((section) => list.append(projectItem(section)));
    card.append(list);
    if (stalled) {
      card.append(FA.navRow({
        // A question to the person, not an alarm: danger red belongs to overdue tasks only.
        icon: "question",
        onClick: () => FA.go("#projects"),
        subtitle: "Скажите боту, что дальше",
        title: "Без следующего шага · " + stalled.rows.length,
      }));
    }
    block.append(card);
    return block;
  }

  const FOLDED = ["unowned", "waiting", "unaccepted", "unsorted", "ideas", "rituals"];
  const DAYS = ["день", "дня", "дней"];
  const pad = (n) => String(n).padStart(2, "0");

  /**
   * The chat's overdue detail («срок 14.10») with how late it is: «срок 14 октября · 2 дня назад».
   * A day without a year is the latest such day not after today; a detail it cannot read stays as is.
   */
  /** The day an overdue detail («срок 14.10») names: the latest such day not after today; null if unreadable. */
  FA.overdueDay = function overdueDay(detail, today) {
    const match = /срок (\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/u.exec(detail || "");
    if (!match) return null;
    const year = match[3] ? Number(match[3].length === 2 ? "20" + match[3] : match[3]) : Number(today.slice(0, 4));
    let day = year + "-" + pad(match[2]) + "-" + pad(match[1]);
    if (!match[3] && day > today) day = (year - 1) + "-" + pad(match[2]) + "-" + pad(match[1]);
    return Number.isNaN(Date.parse(day + "T00:00:00Z")) ? null : day;
  };

  /** «срок 14.10» with how late it is: «срок 14 октября · 2 дня назад»; a detail it cannot read stays as is. */
  function overdueDetail(detail, today) {
    const day = FA.overdueDay(detail, today);
    if (!day) return detail;
    const late = Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(day + "T00:00:00Z")) / 86400000);
    if (late < 0) return detail;
    const ago = late === 0 ? "сегодня" : late === 1 ? "вчера" : FA.count(late, DAYS) + " назад";
    return detail.replace(/срок \d{1,2}\.\d{1,2}(?:\.\d{2,4})?/u, "срок " + FA.dayMonth(day) + " · " + ago);
  }

  /** «Просрочено 2 · Сегодня 8 · Ничьи 2 · Жду 1»: a tap scrolls to the section and opens it. */
  function jumpStrip(targets) {
    const strip = el("nav", "chips chips-scroll jump-strip");
    strip.setAttribute("aria-label", "Разделы доски");
    targets.forEach((target) => {
      const chip = button("chip jump-chip" + (target.danger ? " is-danger" : ""), "", () => {
        if (target.box.expand) target.box.expand();
        const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
        target.box.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
        const first = target.box.querySelector("button");
        if (first) first.focus({ preventScroll: true });
      });
      chip.append(el("span", null, target.label), el("span", "jump-count", String(target.count)));
      strip.append(chip);
    });
    return strip;
  }

  // The parts of «Сегодня» (home-blocks.js builds the screen from them).
  FA.boardParts = { fold, jumpStrip, overdueDetail, projectsBlock, todayCard, FOLDED };
})();
