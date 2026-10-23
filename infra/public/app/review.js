// «Разобрать» (#review): tasks that have not moved for two weeks, one card at a time (docs/design/task-lists-v3.ru.md).
// Each card is answered in one tap: the main button «Сделано», then «Через неделю», «Снять», «Оставить». The answers
// are the same the chat message gives (/app-api/stale); «Сделано» and «Снять» are the ordinary task actions. No model
// here (решение 18 октября 2026): help with a first step is the chat's «Помоги начать».
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;

  FA.screen("review", {
    parent: "#board",
    parentLabel: "Сегодня",
    tab: "board",
    title: "Разобрать",
    async render(view, _arg, ctx) {
      let { tasks } = await FA.load(view, () => FA.get("/app-api/stale"), "Загружаю дела…");
      // Counted from what was answered: the list read again after an answer may have grown (ревью 21 октября 2026).
      let answered = 0;
      FA.header(view, { title: "Разобрать" });
      const body = el("div", "review");
      const place = el("div", "card-actions-errors");
      view.append(body, place);

      function finish() {
        ctx.main.set(null);
        body.replaceChildren(FA.empty("Всё разобрано.", "Давних дел больше нет. Спасибо, что нашли минуту."));
      }

      function draw() {
        place.replaceChildren();
        const task = tasks[0];
        if (!task) return finish();
        const done = answered + 1;
        const total = answered + tasks.length;
        const progress = el("div", "progress");
        const bar = el("span");
        bar.style.width = Math.round(((done - 1) / Math.max(total, 1)) * 100) + "%";
        progress.append(bar);
        progress.setAttribute("role", "progressbar");
        progress.setAttribute("aria-valuemin", "0");
        progress.setAttribute("aria-valuemax", String(total));
        progress.setAttribute("aria-valuenow", String(done - 1));
        const card = FA.card("review-card");
        card.append(
          el("p", "review-count", done + " из " + total),
          el("p", "task-meta", "Не менялось с " + FA.dayMonth(task.since) + (task.project ? " · " + task.project : "")),
          FA.bdi(task.title, "review-title"),
          el("p", "task-meta", "Нужна помощь с первым шагом — нажмите «Помоги начать» под сообщением в чате."),
        );
        const actions = el("div", "card-actions");
        const later = button("secondary-button", "", () => answer(task, "week", later));
        later.append(FA.icon("calendar"), el("span", null, "Через неделю"));
        // «Снять» is not a deletion: no red and no bin (style guide §4, task.js).
        const drop = button("secondary-button", "", async () => {
          const sure = await FA.confirm("Снять это дело?", "Снять", "История сохранится, вернуть можно из «Закрытых».");
          if (sure) await act(task, "cancel", drop);
        });
        drop.append(el("span", null, "Снять"));
        const keep = button("secondary-button", "Оставить", () => answer(task, "keep", keep));
        actions.append(later, drop, keep);
        body.replaceChildren(progress, card, actions);
        ctx.main.set({ onClick: () => act(task, "complete", null), text: "Сделано" });
      }

      // «Через неделю» and «Оставить» answer with the list as it is now.
      // «Повторить» sends the same nonce: a lost answer is replayed, not a second change.
      async function answer(task, action, control, nonce = FA.nonce()) {
        await FA.busy(control, async () => {
          try {
            const result = await FA.post("/app-api/stale/" + encodeURIComponent(task.id) + "/" + action, { version: task.version }, nonce);
            FA.haptic("success");
            FA.board.invalidate();
            FA.toast(result.line);
            answered += 1;
            tasks = result.tasks;
            if (ctx.live()) draw();
          } catch (error) {
            if (ctx.live()) FA.failed(error, place, () => answer(task, action, control, nonce));
          }
        });
      }

      async function act(task, action, control, nonce = FA.nonce()) {
        const work = async () => {
          try {
            const result = await FA.taskAction(task.id, action, task.version, null, nonce);
            FA.haptic("success");
            FA.board.invalidate();
            if (action === "complete") FA.doneToast(task.title, result.task, false);
            else FA.toast("Снято: " + task.title);
            answered += 1;
            tasks = tasks.filter((item) => item.id !== task.id);
            if (ctx.live()) draw();
          } catch (error) {
            if (ctx.live()) FA.failed(error, place, () => act(task, action, control, nonce));
          }
        };
        if (control) await FA.busy(control, work); else await ctx.main.run(work);
      }

      draw();
    },
  });
})();
