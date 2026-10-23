// The task card (#task/<id>) and its «Перенести» sheet; «Новое дело» lives in add.js.
// The card draws only the buttons named in `actions`; after any change it is read again from the server,
// so what the person sees is what the registry holds, not what the page guessed.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;

  const DAYS = ["день", "дня", "дней"];

  function dueText(task) {
    if (task.dueAt) {
      const at = new Date(task.dueAt);
      if (!Number.isNaN(at.getTime())) {
        return new Intl.DateTimeFormat("ru-RU", { day: "numeric", hour: "2-digit", minute: "2-digit", month: "long" }).format(at);
      }
    }
    return task.dueOn ? FA.dayMonth(task.dueOn) : "Без срока";
  }

  function field(icon, label, value) {
    const row = el("div", "field-row");
    row.append(FA.icon(icon, "field-icon"), el("span", "field-label", label));
    const shown = FA.bdi(value, "field-value");
    row.append(shown);
    return row;
  }

  /** The person's today: «Сегодня», «Завтра» and «Выходные» count from it, as the server does. The card brings it. */
  async function today(task) {
    return task.today || (await FA.board.get()).today;
  }

  const CHOICES = [
    { icon: "sun", label: "Сегодня", to: "today" },
    { icon: "calendar", label: "Завтра", to: "tomorrow" },
    { icon: "sofa", label: "Выходные", to: "weekend" },
    { icon: "calendar", label: "Выбрать дату", to: "date" },
  ];

  function dayOf(to, day) {
    if (to === "today") return day;
    if (to === "tomorrow") return FA.addDays(day, 1);
    return FA.weekend(day);
  }

  /** A date input bounded as the server bounds it: from today to a year ahead. */
  function dateInput(day, id) {
    const input = el("input", "text-input");
    input.type = "date";
    input.id = id;
    input.min = day;
    input.max = FA.addDays(day, 366);
    return input;
  }

  function postponeSheet(task, place, ctx) {
    return async () => {
      let day;
      try {
        day = await today(task);
      } catch (error) {
        FA.failed(error, place);
        return;
      }
      let choice = null;
      let sheet = null;
      const summary = el("p", "sheet-summary");
      summary.setAttribute("aria-live", "polite");
      const errorPlace = el("div");
      const picker = el("div", "field-block");
      const input = dateInput(day, "postpone-date");
      const label = el("label", "field-caption", "Дата");
      label.htmlFor = input.id;
      picker.append(label, input);
      picker.hidden = true;

      // A chosen day is one operation with its own nonce: «Повторить» and a second «Сохранить дату» resend
      // it as is; picking another day starts a new one.
      function pick(to, dueOn) {
        choice = to && dueOn ? { dueOn, nonce: FA.nonce(), to } : null;
        summary.textContent = choice ? "Новая дата: " + FA.dayMonth(dueOn) : "";
        sheet.setMain({ disabled: !choice, onClick: save, text: "Сохранить дату" });
      }

      async function save() {
        if (!choice) return;
        const sent = choice;
        await sheet.main.run(async () => {
          errorPlace.replaceChildren();
          // The choice cannot change while it is being sent.
          FA.lockForm(sheet.body, true);
          try {
            const extra = sent.to === "date" ? { dueOn: sent.dueOn, to: "date" } : { on: day, to: sent.to };
            await FA.taskAction(task.id, "postpone", task.version, extra, sent.nonce);
            FA.haptic("success");
            FA.board.invalidate();
            sheet.close();
            FA.toast("Перенесено на " + FA.dayMonth(sent.dueOn));
            if (ctx.live()) FA.refresh();
          } catch (error) {
            FA.lockForm(sheet.body, false);
            if (error.status === 409) sheet.close();
            if (ctx.live()) FA.failed(error, errorPlace, save);
          }
        });
      }

      sheet = FA.openSheet({
        build(body) {
          const grid = el("div", "choice-grid");
          CHOICES.forEach((item) => {
            const node = button("choice", "", () => {
              grid.querySelectorAll(".choice").forEach((other) => other.setAttribute("aria-pressed", String(other === node)));
              picker.hidden = item.to !== "date";
              if (item.to === "date") {
                input.focus();
                pick(input.value ? "date" : null, input.value);
              } else {
                pick(item.to, dayOf(item.to, day));
              }
            });
            node.setAttribute("aria-pressed", "false");
            node.append(FA.icon(item.icon, "choice-icon"), el("span", null, item.label));
            grid.append(node);
          });
          input.addEventListener("change", () => pick(input.value ? "date" : null, input.value));
          body.append(grid, picker, summary, errorPlace);
        },
        main: { disabled: true, onClick: () => save(), text: "Сохранить дату" },
        title: "Перенести",
      });
    };
  }

  // «Беру» before «Сделано»: an unowned task is taken first, as on the board.
  const MAIN = [["accept", "Беру"], ["accept_transfer", "Беру"], ["claim", "Беру"], ["complete", "Сделано"], ["reopen", "Вернуть"]];
  const SAID = {
    accept: "Теперь это ваше", accept_transfer: "Теперь это ваше", claim: "Теперь это ваше", complete: "Сделано",
    decline: "Автор узнает, что вы не можете", decline_transfer: "Передача отменена", release: "Теперь это дело ничьё",
    reopen: "Дело возвращено", share: "Теперь видят все в семье", transfer: "Предложено. Пока не ответят, дело ваше",
    unshare: "Теперь только у вас",
  };

  /**
   * «Передать…»: another person of the family, who answers it; until then the task stays the person's own
   * (`shared-task-handover.ts`). «Сделать ничьим» when the task is the family's. A personal task becomes the family's.
   */
  function transferSheet(task, run) {
    return async () => {
      let people;
      try {
        people = (await FA.get("/app-api/participants")).participants.filter((person) => !person.me);
      } catch (error) {
        FA.toast(FA.errorText(error), { error: true });
        return;
      }
      const sheet = FA.openSheet({
        build(body) {
          const list = el("div", "dialog-buttons");
          people.forEach((person) => {
            const pick = button("secondary-button wide", "", async () => {
              sheet.close();
              await run("transfer", null, FA.nonce(), { assigneeRef: person.ref });
            });
            pick.append(FA.icon("person"), FA.bdi(person.name));
            list.append(pick);
          });
          if (task.actions.indexOf("release") !== -1) {
            const free = button("secondary-button wide", "", async () => {
              sheet.close();
              await run("release", null, FA.nonce());
            });
            free.append(FA.icon("people"), el("span", null, "Сделать ничьим"));
            list.append(free);
          }
          if (people.length === 0) list.append(el("p", "sheet-text", "В семье пока нет других участников."));
          body.append(list);
        },
        title: "Кому передать",
      });
    };
  }

  FA.screen("task", {
    parent: "#board",
    parentLabel: "Сегодня",
    tab: "board",
    title: "Дело",
    async render(view, id, ctx) {
      const { task } = await FA.load(view, () => FA.get("/app-api/tasks/" + encodeURIComponent(id)));
      const header = FA.header(view, { title: task.title });
      header.querySelector(".page-title").dir = "auto";
      // Who the task waits for comes first: a request that hangs is what the person needs to see.
      if (task.waiting) {
        const waits = el("p", "waiting-line");
        waits.append(FA.icon("clock"), FA.bdi(task.waiting));
        header.append(waits);
      }
      if (task.overdueDays > 0) {
        const late = el("p", "overdue-line");
        late.append(FA.icon("warning"), el("span", null, "Просрочено · на " + FA.count(task.overdueDays, DAYS)));
        header.append(late);
      } else if (task.status === "completed" || task.status === "cancelled") {
        const state = el("p", "state-line");
        state.append(FA.icon(task.status === "completed" ? "check-circle" : "minus-circle"),
          el("span", null, task.status === "completed" ? "Сделано" : "Снято"));
        header.append(state);
      }

      // A tradition or an idea has no date and no assignee to speak of: only who sees it (review of 21 October 2026).
      const kept = task.kind === "idea" || task.kind === "ritual";
      const fields = FA.card("fields");
      if (task.project) fields.append(field("folder", "Проект", task.project));
      if (!kept) {
        fields.append(field("calendar", "Срок", dueText(task)));
        fields.append(field("person", "Кто", task.assignee || "Никто не взял"));
      }
      fields.append(field("people", "Видимость", task.visibility));
      if (task.repeat && !kept) fields.append(field("repeat", "Повтор", "Повторяется"));
      view.append(fields);
      // Who sees it: a row under «Видимость», not the main action. Defined below with the other actions.
      const visibilityPlace = el("div", "visibility-action");
      view.append(visibilityPlace);
      if (task.details) {
        const details = FA.card("details");
        details.append(FA.bdi(task.details, "details-text"));
        view.append(details);
      }

      if (task.history && task.history.length > 0) {
        view.append(FA.sectionTitle("История"));
        const timeline = el("ol", "timeline");
        task.history.forEach((entry) => {
          const item = el("li", "timeline-item");
          // The server writes these lines as they are meant to be read («Артём · создано»); shown as is.
          item.append(el("span", "timeline-at", entry.at), FA.bdi(entry.text, "timeline-text"));
          timeline.append(item);
        });
        view.append(timeline);
      }

      const has = (action) => task.actions.indexOf(action) !== -1;
      const place = el("div", "card-actions-errors");
      const mainAction = MAIN.find(([action]) => has(action));

      // One action at a time on one version: while it is out, the other buttons of the card are locked.
      // «Повторить» resends the same operation with its nonce; a new tap is a new one.
      async function run(action, control, nonce, extra) {
        const work = async () => {
          FA.lockForm(bar, true);
          FA.lockForm(visibilityPlace, true);
          try {
            const result = await FA.taskAction(task.id, action, task.version, extra || null, nonce);
            FA.haptic("success");
            FA.board.invalidate();
            if (action === "complete") FA.doneToast(task.title, result.task, task.repeat);
            else if (action === "transfer") FA.toast(SAID.transfer);
            else if (action === "cancel") FA.toast("Снято: " + task.title);
            else FA.toast(SAID[action]);
            if (!ctx.live()) return;
            // After «Не могу» or «Снять» the task is no longer this person's to look at here. Sharing may
            // move a personal task into a shared copy with a new id: the card follows it in place.
            if (action === "decline" || action === "cancel") FA.back();
            else if (result.task && result.task.id !== task.id) FA.replace("#task/" + encodeURIComponent(result.task.id));
            else FA.refresh();
          } catch (error) {
            FA.lockForm(bar, false);
            FA.lockForm(visibilityPlace, false);
            if (ctx.live()) FA.failed(error, place, () => run(action, control, nonce, extra));
          }
        };
        if (ctx.main.busy || bar.hasAttribute("aria-busy") || visibilityPlace.hasAttribute("aria-busy")) return;
        if (control) await FA.busy(control, work); else await ctx.main.run(work);
      }

      const bar = el("div", "card-actions");
      if (has("complete") && mainAction[0] !== "complete") {
        const done = button("secondary-button", "Сделано", () => run("complete", done, FA.nonce()));
        bar.append(done);
      }
      if (has("decline")) {
        const no = button("secondary-button", "Не могу", () => run("decline", no, FA.nonce()));
        bar.append(no);
      }
      if (has("decline_transfer")) {
        // The recipient says no; the sender takes the offer back. Either way the task stays the sender's.
        const label = has("accept_transfer") ? "Не могу" : "Отменить передачу";
        const no = button("secondary-button", label, () => run("decline_transfer", no, FA.nonce()));
        bar.append(no);
      }
      if (has("transfer")) {
        const give = button("secondary-button", "", transferSheet(task, run));
        give.append(FA.icon("person-send"), el("span", null, "Передать…"));
        bar.append(give);
      }
      if (has("postpone")) {
        const move = button("secondary-button", "", postponeSheet(task, place, ctx));
        move.append(FA.icon("calendar"), el("span", null, "Перенести"));
        bar.append(move);
      }
      if (has("cancel")) {
        // Not a deletion: the task goes to «Закрытые» and comes back from there, so no bin and no red.
        const what = task.kind === "ritual" ? "эту традицию" : task.kind === "idea" ? "эту идею" : "это дело";
        const drop = button("secondary-button", "", async () => {
          const sure = await FA.confirm("Снять " + what + "?", "Снять", task.kind === "task"
            ? "Оно уйдёт в «Закрытые», вернуть можно оттуда." : "Вернуть можно в чате.");
          if (sure) await run("cancel", drop, FA.nonce());
        });
        drop.append(FA.icon("minus-circle"), el("span", null, "Снять"));
        bar.append(drop);
      }
      // Whatever the server offers, for tasks, ideas and traditions alike; an idea or a tradition is shown
      // to the family rather than «made shared», and goes back «only to me» while nobody else planned it.
      const visibilityAction = has("share") ? ["share", "people", kept ? "Показать семье" : "Сделать общим"]
        : has("unshare") ? ["unshare", "lock", kept ? "Только мне" : "Сделать личным"] : null;
      if (visibilityAction) {
        const [action, icon, label] = visibilityAction;
        const toggle = button("secondary-button wide", "", () => run(action, toggle, FA.nonce()));
        toggle.append(FA.icon(icon), el("span", null, label));
        visibilityPlace.append(toggle);
      }
      // A tradition's own action: «Было сегодня», the same mark as on «Традиции».
      if (task.kind === "ritual" && task.status !== "cancelled" && task.status !== "completed") {
        // One operation per tap, made when tapped (a card left open past midnight is a new day); «Повторить» resends it.
        const markDay = (nonce) => FA.busy(mark, async () => {
          FA.lockForm(bar, true);
          try {
            await FA.post("/app-api/family/traditions/" + encodeURIComponent(task.id) + "/done", {}, nonce);
            FA.haptic("success");
            FA.toast("Отмечено: " + task.title);
          } catch (error) {
            FA.failed(error, place, () => markDay(nonce));
          } finally {
            FA.lockForm(bar, false);
          }
        });
        const mark = button("secondary-button", "", () => markDay(FA.nonce()));
        mark.append(FA.icon("check-circle"), el("span", null, "Было сегодня"));
        bar.prepend(mark);
      }
      if (bar.childElementCount > 0) view.append(bar);
      view.append(place);
      if (mainAction) ctx.main.set({ onClick: () => run(mainAction[0], null, FA.nonce()), text: mainAction[1] });
    },
  });

  // Shared with the add page (add.js).
  FA.dayOf = dayOf;
  FA.dateInput = dateInput;
})();
