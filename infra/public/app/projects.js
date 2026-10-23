// «Проекты» and «Что уже сделано?». The list comes from the project repository (`/app-api/projects`), the next
// step of each from the board; a card opens the project's page (project.js). «Новый проект» is made here.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;

  /** A project card: its name, progress and next step; the whole card opens the project's page. */
  function projectCard(project, nextStep) {
    const stalled = project.status === "accepted" && project.open === 0 && project.total === 0;
    const card = FA.card("project-card" + (stalled ? " is-stalled" : ""));
    const go = button("project-card-toggle", "", () => FA.go("#project/" + encodeURIComponent(project.id)));
    const head = el("span", "project-card-head");
    head.append(FA.icon("folder", "project-card-icon"), FA.bdi(project.title, "project-card-name"));
    go.append(head, FA.icon("chevron-right", "fold-chevron"));
    if (project.total > 0) {
      const line = el("span", "project-card-line");
      line.append(FA.progressLine(project), el("span", "project-count", project.completed + " из " + project.total));
      go.append(line);
    }
    const next = el("span", "project-next");
    if (stalled) {
      next.append(FA.icon("warning", "meta-icon"), el("span", null, "Нет следующего шага"));
    } else if (project.status === "accepted" && project.open === 0) {
      next.append(el("span", null, "Все шаги сделаны — можно завершить"));
    } else if (nextStep) {
      next.append(el("span", "project-next-label", "Следующий шаг"), FA.bdi(nextStep, "project-next-title"));
    } else if (project.status === "completed") {
      next.append(el("span", null, "Завершён"));
    }
    go.append(next);
    card.append(go);
    return card;
  }

  /** «Новый проект»: a name and its first step, as a project without a next step has no point. */
  FA.newProjectSheet = function newProjectSheet() {
    let sheet = null;
    let last = null;
    const errors = el("div");
    const field = (id, label, placeholder) => {
      const block = el("div", "field-block");
      const caption = el("label", "field-caption", label);
      const input = el("input", "text-input");
      input.id = id;
      input.maxLength = id === "project-title" ? 100 : 300;
      input.placeholder = placeholder;
      input.autocomplete = "off";
      caption.htmlFor = id;
      block.append(caption, input);
      return { block, input };
    };
    const name = field("project-title", "Название", "Например: Ремонт ванной");
    const first = field("project-step", "Первый шаг", "Например: Снять мерки");
    const ready = () => name.input.value.trim().length > 0 && first.input.value.trim().length > 0;
    async function save() {
      if (!ready()) return;
      const body = { step: first.input.value.trim(), title: name.input.value.trim() };
      const key = JSON.stringify(body);
      // The same fields are the same project: a retry after a lost answer does not make a second first step.
      if (!last || last.key !== key) last = { key, nonce: FA.nonce() };
      await sheet.main.run(async () => {
        errors.replaceChildren();
        FA.lockForm(sheet.body, true);
        try {
          const { project } = await FA.post("/app-api/projects", body, last.nonce);
          FA.haptic("success");
          FA.board.invalidate();
          sheet.close();
          if (project) FA.go("#project/" + encodeURIComponent(project.id)); else FA.refresh();
        } catch (error) {
          FA.lockForm(sheet.body, false);
          FA.failed(error, errors, save);
        }
      });
    }
    sheet = FA.openSheet({
      build(body) {
        body.append(name.block, first.block, el("p", "sheet-text", "Проект будет вашим; показать его семье можно в чате."), errors);
        [name.input, first.input].forEach((input) => input.addEventListener("input", () => sheet.setMain({ disabled: !ready(), onClick: save, text: "Создать" })));
        name.input.focus();
      },
      main: { disabled: true, onClick: () => save(), text: "Создать" },
      title: "Новый проект",
    });
  };

  FA.screen("projects", {
    parent: "#board",
    parentLabel: "Сегодня",
    tab: "board",
    title: "Проекты",
    async render(view, _arg, ctx) {
      FA.header(view, { title: "Проекты" });
      const [board, listed] = await FA.load(view, () => Promise.all([FA.board.get(true), FA.get("/app-api/projects")]));
      // The next step is the first open task the board shows under the project.
      const nextOf = new Map();
      board.sections.filter((section) => section.kind === "project" && section.project)
        .forEach((section) => nextOf.set(section.project.id, section.rows[0] && section.rows[0].title));
      const live = listed.projects.filter((project) => project.status === "accepted");
      const done = listed.projects.filter((project) => project.status === "completed");
      const active = live.map((project) => projectCard(project, nextOf.get(project.id)));
      const finished = done.map((project) => projectCard(project, null));
      // A cancelled project can be brought back on its page («Вернуть в работу»), so it stays findable: a tab of its
      // own, shown once there is one (review of 23 October 2026).
      const cancelled = listed.projects.filter((project) => project.status === "cancelled").map((project) => projectCard(project, null));

      const segments = el("div", "segments");
      segments.setAttribute("role", "group");
      segments.setAttribute("aria-label", "Какие проекты");
      const list = el("div", "card-stack");
      const tabs = [["active", "Активные", active, "Активных проектов нет"], ["done", "Готовые", finished, "Готовых проектов пока нет"]];
      if (cancelled.length > 0) tabs.push(["cancelled", "Отменённые", cancelled, "Отменённых проектов нет"]);
      function paint(which) {
        FA.uiSet("projects.segment", which);
        segments.querySelectorAll("button").forEach((node) => node.setAttribute("aria-pressed", String(node.dataset.id === which)));
        const chosen = tabs.find((tab) => tab[0] === which);
        list.replaceChildren(...(chosen[2].length > 0 ? chosen[2] : [FA.empty(chosen[3], "Новый проект — кнопкой внизу.", "folder")]));
      }
      tabs.forEach(([id, label]) => {
        const node = button("segment", label, () => paint(id));
        node.dataset.id = id;
        segments.append(node);
      });
      view.append(segments, list);
      // A remembered tab this version does not have (an older or broken value) falls back to the active projects.
      const remembered = FA.uiGet("projects.segment", "active");
      paint(tabs.some((tab) => tab[0] === remembered) ? remembered : "active");
      ctx.main.set({ onClick: () => FA.newProjectSheet(), text: "Новый проект" });
    },
  });

  FA.screen("mark-done", {
    parent: "#board",
    parentLabel: "Сегодня",
    tab: "board",
    title: "Что уже сделано?",
    async render(view, _arg, ctx) {
      FA.header(view, { subtitle: "Отметьте всё, что закрыли, одним разом", title: "Что уже сделано?" });
      const board = await FA.load(view, () => FA.board.get(true));
      // One task can sit in «Сегодня» and in its project at once; it is offered once, in its first section.
      const seen = new Set();
      const picked = new Map();
      const groups = [];
      board.sections.forEach((section) => {
        const rows = section.rows.filter((row) => row.id && row.actions.indexOf("complete") !== -1 && !seen.has(row.id));
        rows.forEach((row) => seen.add(row.id));
        if (rows.length > 0) groups.push({ rows, title: section.kind === "project" ? section.title : FA.plainTitle(section.title) });
      });
      if (groups.length === 0) {
        view.append(FA.empty("Закрывать нечего", "Здесь появятся ваши дела, которые можно отметить сделанными."));
        return;
      }
      const errors = el("div", "mark-errors");
      view.append(errors);
      const boxes = new Map();
      groups.forEach((group, index) => {
        const card = FA.card("mark-card");
        const titleId = "mark-" + index;
        const head = el("h2", "card-title", group.title);
        head.id = titleId;
        const list = el("ul", "mark-list");
        list.setAttribute("aria-labelledby", titleId);
        group.rows.forEach((row) => {
          const item = el("li", "mark-row");
          const label = el("label", "mark-label");
          const input = el("input", "mark-input");
          input.type = "checkbox";
          input.addEventListener("change", () => {
            if (input.checked) picked.set(row.id, row); else picked.delete(row.id);
            item.classList.toggle("is-picked", input.checked);
            FA.haptic("select");
            paintMain();
          });
          label.append(input, el("span", "mark-box"), FA.bdi(row.title, "mark-title"));
          item.append(label);
          list.append(item);
          boxes.set(row.id, { input, item });
        });
        card.append(head, list);
        view.append(card);
      });

      function paintMain() {
        const n = picked.size;
        ctx.main.set(n === 0 ? null : { onClick: submit, text: "Закрыть " + FA.count(n, FA.TASKS) });
      }

      // One request per task, one after another: a failure stops nothing else, and the failed ones stay
      // ticked with the reason next to the list. A task keeps its nonce across a second «Закрыть», so one
      // whose answer was lost the first time is not closed twice. The ticks are locked while this runs.
      const nonces = new Map();
      async function submit() {
        await ctx.main.run(async () => {
          errors.replaceChildren();
          FA.lockForm(view, true);
          const failures = [];
          let closed = 0;
          for (const row of Array.from(picked.values())) {
            if (!nonces.has(row.id)) nonces.set(row.id, FA.nonce());
            try {
              await FA.taskAction(row.id, "complete", row.version, null, nonces.get(row.id));
              closed += 1;
              picked.delete(row.id);
              const box = boxes.get(row.id);
              box.item.classList.add("is-done");
              // Closed for good: the unlock below must not give this tick back.
              delete box.input.dataset.locked;
            } catch (error) {
              failures.push({ error, row });
            }
          }
          FA.lockForm(view, false);
          FA.board.invalidate();
          if (closed > 0) FA.haptic("success");
          if (failures.length === 0) {
            FA.toast("Закрыто: " + closed);
            if (ctx.live()) FA.back();
            return;
          }
          FA.haptic("error");
          if (closed > 0) FA.toast("Закрыто: " + closed);
          const box = el("div", "inline-error");
          box.setAttribute("role", "alert");
          box.append(FA.icon("warning", "inline-error-icon"));
          const text = el("div", "inline-error-text");
          text.append(el("p", null, "Не получилось закрыть " + FA.count(failures.length, FA.TASKS) + ":"));
          const list = el("ul", "error-list");
          failures.forEach(({ error, row }) => {
            const item = el("li");
            const why = error.status === 409 ? "его уже изменили, откройте доску заново" : FA.errorText(error);
            item.append(FA.bdi(row.title), el("span", null, " — " + why));
            list.append(item);
          });
          text.append(list);
          box.append(text);
          errors.append(box);
          paintMain();
        });
      }
      paintMain();
    },
  });
})();
