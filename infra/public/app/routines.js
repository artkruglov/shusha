// «Напоминания и регулярное»: the person's reminders and the bot's scheduled jobs, with a switch each,
// «Запустить сейчас» for a job, and «Удалить» behind «•••» (or a long press). Every answer of the server
// carries the whole list, so the screen is drawn again from it; a switch flips only after that answer.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;

  function action(routine, verb, nonce) {
    return FA.post("/app-api/routines/" + routine.kind + "/" + encodeURIComponent(routine.id) + "/" + verb, null, nonce);
  }

  FA.screen("routines", {
    parent: "#more",
    parentLabel: "Ещё",
    tab: "more",
    title: "Напоминания и регулярное",
    async render(view) {
      FA.header(view, { shusha: "shusha-list", title: "Напоминания и регулярное" });
      const first = await FA.load(view, () => FA.get("/app-api/routines"));
      const body = el("div");
      view.append(body, el("p", "footnote", "Новое напоминание можно записать в чате."));

      // One change at a time for the whole list: the answer redraws everything, so a second change sent
      // meanwhile would act on rows that are about to be replaced. «Повторить» resends with the same nonce.
      let pending = false;
      async function change(routine, verb, control, place, said, nonce) {
        if (pending) return;
        pending = true;
        FA.lockForm(body, true);
        const id = nonce || FA.nonce();
        let data = null;
        try {
          await FA.busy(control, async () => {
            data = await action(routine, verb, id);
          });
        } catch (error) {
          FA.lockForm(body, false);
          pending = false;
          FA.failed(error, place, () => change(routine, verb, control, place, said, id));
          return;
        }
        pending = false;
        FA.haptic("success");
        if (said) FA.toast(said);
        draw(data);
      }

      function menu(routine, place) {
        return () => {
          const sheet = FA.openSheet({
            build(sheetBody) {
              sheetBody.append(FA.bdi(routine.title, "sheet-text"));
              const remove = button("secondary-button danger wide", "", async () => {
                sheet.close();
                const what = routine.kind === "schedule" ? "Удалить это регулярное задание?" : "Удалить это напоминание?";
                if (!(await FA.confirm(what, "Удалить"))) return;
                const holder = place.querySelector(".more-button") || place;
                await change(routine, "delete", holder, place, "Удалено");
              });
              remove.append(FA.icon("trash"), el("span", null, "Удалить"));
              sheetBody.append(remove);
            },
            title: routine.kind === "schedule" ? "Регулярное задание" : "Напоминание",
          });
        };
      }

      function moreButton(routine, place) {
        const node = button("icon-button more-button", "", menu(routine, place));
        node.setAttribute("aria-label", "Ещё: " + routine.title);
        node.append(FA.icon("dots"));
        place.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          node.click();
        });
        return node;
      }

      function switchFor(routine, place) {
        const control = button("switch", "", () => change(routine, routine.enabled ? "disable" : "enable", control, place));
        control.setAttribute("role", "switch");
        control.setAttribute("aria-checked", String(routine.enabled));
        control.setAttribute("aria-label", (routine.kind === "schedule" ? "Включено: " : "Напоминать: ") + routine.title);
        return control;
      }

      function failedLine() {
        const line = el("p", "routine-failed");
        line.append(FA.icon("warning"), el("span", null, "Последний раз не получилось. Можно запустить снова."));
        return line;
      }

      function scheduleCard(routine) {
        const card = FA.card("routine-card");
        const top = el("div", "routine-top");
        top.append(FA.icon("news", "routine-icon"));
        const text = el("div", "routine-text");
        text.append(FA.bdi(routine.title, "routine-title"));
        if (routine.repeat) text.append(el("span", "routine-sub", routine.repeat));
        text.append(el("span", "routine-sub", !routine.enabled ? "Выключено" : routine.next ? "Следующий раз: " + routine.next : "Следующий раз не назначен"));
        top.append(text, switchFor(routine, card), moreButton(routine, card));
        card.append(top);
        if (routine.failed) card.append(failedLine());
        const run = button("outline-button wide", "Запустить сейчас", () => change(routine, "run", run, card, "Запустил. Результат придёт в чат."));
        card.append(run);
        return card;
      }

      function reminderRow(routine) {
        const item = el("li", "routine-row");
        item.append(FA.icon(routine.repeat ? "repeat" : "bell", "routine-icon"));
        const text = el("div", "routine-text");
        text.append(FA.bdi(routine.title, "routine-title"));
        const sub = !routine.enabled ? "Выключено" : routine.repeat || routine.next;
        if (sub) text.append(el("span", "routine-sub", sub));
        if (routine.failed) text.append(failedLine());
        item.append(text, switchFor(routine, item), moreButton(routine, item));
        return item;
      }

      function draw(data) {
        body.replaceChildren();
        body.append(FA.sectionTitle("Регулярные задания"));
        if (data.schedules.length === 0) {
          body.append(el("p", "quiet-card", "Регулярных заданий нет. Например: «Каждое утро в 8:00 присылай новости и погоду»."));
        } else {
          const stack = el("div", "card-stack");
          data.schedules.forEach((routine) => stack.append(scheduleCard(routine)));
          body.append(stack);
        }
        body.append(FA.sectionTitle("Напоминания"));
        if (data.reminders.length === 0) {
          body.append(el("p", "quiet-card", "Напоминаний нет. Скажите боту: «Напомни завтра в 19:00 позвонить маме»."));
        } else {
          const card = FA.card();
          const list = el("ul", "routine-list");
          data.reminders.forEach((routine) => list.append(reminderRow(routine)));
          card.append(list);
          body.append(card);
        }
      }
      draw(first);
    },
  });
})();
