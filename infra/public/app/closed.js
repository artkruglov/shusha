// «Закрытые за неделю»: what was done and what was dropped, Monday to Sunday in the person's calendar.
// «Вернуть» reopens with the version the week was read at; the server refuses weeks ahead, so the page
// never offers one past the current week.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;
  // The current week's Monday, learned from the first read without a `week`; the arrows stop there.
  let currentFrom = null;

  function closedRow(row, cancelled, onChanged) {
    const item = el("li", "closed-row");
    item.append(FA.icon(cancelled ? "minus-circle" : "check-circle", cancelled ? "closed-icon is-cancelled" : "closed-icon"));
    const text = el("div", "closed-text");
    text.append(FA.bdi(row.title, "task-title"));
    const meta = el("span", "task-meta");
    if (row.repeat) meta.append(FA.icon("repeat", "meta-icon", "Повторяется"));
    meta.append(el("span", null, (cancelled ? "Снято" : "Сделано") + (row.detail ? " · " + row.detail : "")));
    text.append(meta);
    item.append(text);
    if (row.canReopen && !row.repeat) {
      // «Повторить» resends this reopen with its nonce; a new tap on «Вернуть» is a new one.
      const reopen = (nonce) => FA.busy(undo, async () => {
        try {
          await FA.taskAction(row.id, "reopen", row.version, null, nonce);
          FA.haptic("success");
          FA.board.invalidate();
          FA.toast("Дело возвращено: " + row.title);
          onChanged();
        } catch (error) {
          FA.failed(error, text, () => reopen(nonce));
        }
      });
      const undo = button("text-button", "Вернуть", () => reopen(FA.nonce()));
      undo.setAttribute("aria-label", "Вернуть: " + row.title);
      item.append(undo);
    }
    return item;
  }

  function group(title, rows, cancelled, onChanged) {
    const box = el("section", "closed-group");
    box.append(FA.sectionTitle(title + " · " + rows.length));
    const card = FA.card();
    const list = el("ul", "closed-list");
    rows.forEach((row) => list.append(closedRow(row, cancelled, onChanged)));
    card.append(list);
    box.append(card);
    return box;
  }

  FA.screen("closed", {
    // A look back, not a daily place: reached from the board, not from the tab bar.
    parent: "#board",
    parentLabel: "Сегодня",
    tab: "board",
    title: "Закрытые",
    async render(view, _arg, ctx) {
      FA.header(view, { title: "Закрытые за неделю" });
      const week = FA.uiGet("closed.week", null);
      const query = week && currentFrom && week < currentFrom ? "?week=" + week : "";
      const data = await FA.load(view, () => FA.get("/app-api/closed" + query));
      if (!query) currentFrom = data.from;

      const nav = el("div", "week-nav");
      const prev = button("icon-button round", "", () => {
        FA.uiSet("closed.week", FA.addDays(data.from, -7));
        FA.refresh();
      });
      prev.setAttribute("aria-label", "Предыдущая неделя");
      prev.append(FA.icon("chevron-left"));
      const label = el("div", "week-label");
      label.append(el("p", "week-range", data.label));
      label.setAttribute("aria-live", "polite");
      if (data.from === currentFrom) label.append(el("p", "week-sub", "Эта неделя"));
      const next = button("icon-button round", "", () => {
        const target = FA.addDays(data.from, 7);
        FA.uiSet("closed.week", target >= currentFrom ? null : target);
        FA.refresh();
      });
      next.setAttribute("aria-label", "Следующая неделя");
      next.append(FA.icon("chevron-right"));
      next.disabled = data.from >= currentFrom;
      nav.append(prev, label, next);
      view.append(nav);

      const reload = () => {
        if (ctx.live()) FA.refresh();
      };
      if (data.done.length === 0 && data.cancelled.length === 0) {
        view.append(FA.empty("На этой неделе закрытых дел нет", null, "checkbox"));
        return;
      }
      if (data.done.length > 0) view.append(group("Сделано", data.done, false, reload));
      if (data.cancelled.length > 0) view.append(group("Снятые", data.cancelled, true, reload));
      view.append(el("p", "footnote", "Вернуть можно и после этой недели."));
    },
  });
})();
