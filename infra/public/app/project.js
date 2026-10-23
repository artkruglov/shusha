// A project's page (#project/<id>): its steps with «Сделано», «+ шаг», what was done, and what the project
// repository does without the model: rename and describe, finish, cancel, bring back (`/app-api/projects/:id/:action`).
// A step is an ordinary task with `projectRef` (`POST /app-api/tasks`); its own card is the task card.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;

  function stepDetail(step) {
    const when = step.dueAt ? FA.shortDate(step.dueAt) : step.dueOn ? FA.dayMonth(step.dueOn) : null;
    const who = step.status === "proposed" ? "ждёт ответа: " + (step.assignee || "участник") : step.assignee;
    return [when, who].filter(Boolean).join(" · ");
  }

  /** Rename and describe: one sheet, the version read with the page; a stale one is refused and the page read again. */
  function editSheet(project) {
    let sheet = null;
    const errors = el("div");
    const title = el("input", "text-input");
    title.id = "project-edit-title";
    title.maxLength = 100;
    title.value = project.title;
    const details = el("textarea", "text-input");
    details.id = "project-edit-details";
    details.rows = 3;
    details.maxLength = 1000;
    details.value = project.details || "";
    const nonce = FA.nonce();
    async function save() {
      const body = { details: details.value.trim() || null, title: title.value.trim(), version: project.version };
      if (!body.title) return;
      await sheet.main.run(async () => {
        errors.replaceChildren();
        try {
          await FA.post("/app-api/projects/" + encodeURIComponent(project.id) + "/update", body, nonce);
          FA.haptic("success");
          FA.board.invalidate();
          sheet.close();
          FA.refresh();
        } catch (error) {
          if (error.status === 409) sheet.close();
          FA.failed(error, errors, save);
        }
      });
    }
    sheet = FA.openSheet({
      build(body) {
        const label = (input, text) => {
          const caption = el("label", "field-caption", text);
          caption.htmlFor = input.id;
          const block = el("div", "field-block");
          block.append(caption, input);
          return block;
        };
        body.append(label(title, "Название"), label(details, "Цель или заметка"), errors);
        title.addEventListener("input", () => sheet.setMain({ disabled: !title.value.trim(), onClick: save, text: "Сохранить" }));
      },
      main: { onClick: () => save(), text: "Сохранить" },
      title: "Проект",
    });
  }

  FA.screen("project", {
    parent: "#projects",
    parentLabel: "Проекты",
    tab: "board",
    title: "Проект",
    async render(view, id, ctx) {
      const data = await FA.load(view, () => FA.get("/app-api/projects/" + encodeURIComponent(id)));
      const project = data.project;
      const live = project.status === "accepted";
      const header = FA.header(view, {
        subtitle: project.status === "completed" ? "Проект завершён" : project.status === "cancelled" ? "Проект отменён" : null,
        title: project.title,
      });
      header.querySelector(".page-title").dir = "auto";
      if (project.total > 0) {
        const line = el("div", "project-card-line");
        line.append(FA.progressLine(project), el("span", "project-count", project.completed + " из " + project.total));
        header.append(line);
      }
      if (project.details) {
        const note = FA.card("details");
        note.append(FA.bdi(project.details, "details-text"));
        view.append(note);
      }
      const place = el("div");

      view.append(FA.sectionTitle(live ? "Шаги" : "Открытые шаги"));
      if (data.steps.length > 0) {
        // The first open step is the next one, as the board shows it.
        const rows = data.steps.map((step, index) => ({
          actions: step.actions, detail: (index === 0 && live ? "следующий" : "")
            + (index === 0 && live && stepDetail(step) ? " · " : "") + stepDetail(step),
          id: step.id, repeat: false, title: step.title, version: step.version,
        }));
        const card = FA.card("task-card");
        card.append(FA.rowList(rows, null, () => FA.refresh()));
        view.append(card);
      } else {
        view.append(el("p", "footnote", live ? "Открытых шагов нет. Добавьте следующий или завершите проект." : "Открытых шагов нет."));
      }

      if (live) {
        // «+ шаг»: written at once, without the model, into this project.
        const add = el("div", "inline-add");
        const input = el("input", "text-input");
        input.placeholder = "Следующий шаг…";
        input.maxLength = 300;
        input.setAttribute("aria-label", "Новый шаг проекта");
        input.enterKeyHint = "done";
        let last = null;
        const send = button("secondary-button", "Добавить", async () => {
          const title = input.value.trim();
          if (!title) {
            input.focus();
            return;
          }
          if (!last || last.title !== title) last = { nonce: FA.nonce(), title };
          await FA.busy(send, async () => {
            try {
              await FA.post("/app-api/tasks", { projectRef: project.id, title }, last.nonce);
              FA.haptic("success");
              FA.board.invalidate();
              input.value = "";
              last = null;
              FA.refresh();
            } catch (error) {
              FA.failed(error, place, () => send.click());
            }
          });
        });
        input.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          send.click();
        });
        add.append(input, send);
        view.append(add);
      }

      if (data.done.length > 0) {
        view.append(FA.sectionTitle("Сделано"));
        const done = el("ul", "done-list");
        data.done.forEach((step) => {
          const item = el("li", "done-item");
          item.append(FA.icon("check-circle", "meta-icon"), FA.bdi(step.title));
          done.append(item);
        });
        view.append(done);
      }

      async function change(action, control, nonce) {
        await FA.busy(control, async () => {
          try {
            await FA.post("/app-api/projects/" + encodeURIComponent(project.id) + "/" + action, { version: project.version }, nonce);
            FA.haptic("success");
            FA.board.invalidate();
            FA.toast(action === "complete" ? "Проект завершён" : action === "cancel" ? "Проект отменён, его дела остались" : "Проект снова в работе");
            if (ctx.live()) FA.refresh();
          } catch (error) {
            if (ctx.live()) FA.failed(error, place, () => change(action, control, nonce));
          }
        });
      }

      const bar = el("div", "card-actions");
      const edit = button("secondary-button", "", () => editSheet(project));
      edit.append(FA.icon("edit"), el("span", null, "Изменить"));
      bar.append(edit);
      if (live) {
        const drop = button("secondary-button", "", async () => {
          if (await FA.confirm("Отменить проект?", "Отменить", "Его открытые дела останутся сами по себе.")) await change("cancel", drop, FA.nonce());
        });
        drop.append(FA.icon("minus-circle"), el("span", null, "Отменить проект"));
        bar.append(drop);
      }
      view.append(bar, place);
      if (live && project.open === 0) {
        const nonce = FA.nonce();
        ctx.main.set({ onClick: () => ctx.main.run(() => change("complete", edit, nonce)), text: "Завершить проект" });
      } else if (!live) {
        const nonce = FA.nonce();
        ctx.main.set({ onClick: () => ctx.main.run(() => change("reopen", edit, nonce)), text: "Вернуть в работу" });
      }
    },
  });
})();
