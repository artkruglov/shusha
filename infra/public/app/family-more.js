// «Семья» sections that are mostly one's own: personal time (my windows; of the others only that a time
// is taken), someday ideas (a wish is not a duty: no dates, no owner) and «Наш подход», a static page with
// the four ideas behind the bot and their sources.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;

  FA.screen("time", {
    parent: "#family",
    parentLabel: "Семья",
    tab: "family",
    title: "Личное время",
    async render(view, _arg, ctx) {
      FA.header(view, { subtitle: "У каждого своё окно", title: "Личное время" });
      const first = await FA.load(view, () => FA.family.get(true));
      const body = el("div");
      const errors = el("div");
      view.append(body, errors);

      function draw(family) {
        body.replaceChildren(FA.sectionTitle("Моё"));
        if (family.time.mine.length === 0) {
          body.append(el("p", "quiet-card", "Своего окна пока нет. Например: бег по средам с 19 до 21. В это время бот не пишет и не ставит дела."));
        } else {
          const card = FA.card();
          const list = el("ul", "routine-list");
          family.time.mine.forEach((window) => {
            const item = el("li", "routine-row");
            const text = el("div", "routine-text");
            text.append(el("span", "routine-title", FA.weekdayName(window.weekday)));
            text.append(FA.bdi(FA.clockText(window.startsAt) + "–" + FA.clockText(window.endsAt) + " · " + window.title, "routine-sub"));
            const remove = button("text-button", "Убрать", async () => {
              if (!(await FA.confirm("Убрать это окно?", "Убрать"))) return;
              await FA.familyChange({
                lock: body, path: "/app-api/family/time/" + encodeURIComponent(window.id) + "/remove", place: item,
                redraw: draw, run: (work) => FA.busy(remove, work), said: "Окно убрано",
              });
            });
            remove.setAttribute("aria-label", "Убрать: " + window.title);
            item.append(text, remove);
            list.append(item);
          });
          card.append(list);
          body.append(card);
        }
        if (family.time.others.length > 0) {
          body.append(FA.sectionTitle("У других"));
          const card = FA.card();
          const list = el("ul", "routine-list");
          family.time.others.forEach((window) => {
            const item = el("li", "routine-row");
            const text = el("div", "routine-text");
            const day = window.weekday === null ? "каждый день" : FA.WEEKDAYS.find(([value]) => value === window.weekday)[1];
            text.append(FA.bdi(window.name, "routine-title"),
              el("span", "routine-sub", day + " " + FA.clockText(window.startsAt) + "–" + FA.clockText(window.endsAt) + " · занято"));
            item.append(text, FA.icon("lock", "routine-icon", "Только занятость"));
            list.append(item);
          });
          card.append(list);
          body.append(card, el("p", "footnote", "О чужом окне видно только, что время занято."));
        }
      }

      // The same window is the same operation: a retry or a second «Сохранить» resends its nonce.
      let last = null;
      function addWindow() {
        const errorsHere = el("div");
        const name = el("input", "text-input");
        name.id = "window-title";
        name.maxLength = 100;
        name.placeholder = "Бег, мастерская, чтение";
        name.setAttribute("autofocus", "");
        const nameLabel = el("label", "field-caption", "Что это");
        nameLabel.htmlFor = name.id;
        const dayCaption = el("p", "field-caption", "Когда");
        dayCaption.id = "window-day";
        const day = FA.radioGroup({ labelledBy: dayCaption.id, options: FA.WEEKDAYS.map(([value, label]) => [value === null ? "all" : String(value), label]), value: "3" });
        day.node.classList.add("weekday-group");
        const from = FA.timeSelect();
        const to = FA.timeSelect();
        from.value = "19:00";
        to.value = "21:00";
        from.setAttribute("aria-label", "С");
        to.setAttribute("aria-label", "До");
        const times = el("div", "quiet-row sheet-times");
        const fromBox = el("div", "quiet-field");
        fromBox.append(el("span", "field-caption", "С"), from);
        const toBox = el("div", "quiet-field");
        toBox.append(el("span", "field-caption", "До"), to);
        times.append(fromBox, toBox);
        const problem = el("p", "field-error");
        problem.setAttribute("role", "alert");

        const sheet = FA.openSheet({
          build(content) {
            const form = el("div", "form");
            const nameBlock = el("div", "field-block");
            nameBlock.append(nameLabel, name);
            const dayBlock = el("div", "field-block");
            dayBlock.append(dayCaption, day.node);
            form.append(nameBlock, dayBlock, times, problem, errorsHere);
            content.append(form);
          },
          main: { onClick: () => save(), text: "Сохранить окно" },
          title: "Новое окно",
        });

        function save() {
          const title = name.value.trim();
          problem.textContent = "";
          if (!title) {
            problem.textContent = "Назовите окно: например, «Бег».";
            name.focus();
            return;
          }
          if (from.value >= to.value) {
            problem.textContent = "Окно должно закончиться позже, чем начнётся.";
            return;
          }
          const chosen = day.value();
          const payload = { endsAt: to.value, startsAt: from.value, title, weekday: chosen === "all" ? null : Number(chosen) };
          const key = JSON.stringify(payload);
          if (!last || last.key !== key) last = { key, nonce: FA.nonce() };
          FA.familyChange({
            body: payload, lock: sheet.body, nonce: last.nonce, path: "/app-api/family/time", place: errorsHere,
            redraw(data) {
              last = null;
              sheet.close();
              draw(data);
            },
            run: (work) => sheet.main.run(work), said: "Окно добавлено",
          });
        }
      }

      draw(first);
      ctx.main.set({ onClick: addWindow, text: "Добавить окно" });
    },
  });

  FA.screen("someday", {
    parent: "#family",
    parentLabel: "Семья",
    tab: "family",
    title: "Когда-нибудь",
    async render(view, _arg, ctx) {
      FA.header(view, { subtitle: "Идея ничего не обещает", title: "Когда-нибудь" });
      const first = await FA.load(view, () => FA.family.get(true));
      const list = el("div", "card-stack");
      const errors = el("div");
      view.append(list, errors);
      const projectNonce = FA.nonce();

      // «Убрать» cancels the idea task; its answer is the task, so the family is read again after it.
      async function remove(idea, control, card, nonce) {
        FA.lockForm(list, true);
        try {
          await FA.busy(control, () => FA.taskAction(idea.id, "cancel", idea.version, null, nonce));
          FA.haptic("success");
          FA.toast("Идея убрана");
          FA.board.invalidate();
          draw(await FA.family.get(true));
        } catch (error) {
          FA.lockForm(list, false);
          FA.failed(error, card, () => remove(idea, control, card, nonce));
        }
      }

      function draw(family) {
        list.replaceChildren();
        if (family.ideas.length === 0) {
          list.append(FA.empty("Идей пока нет", "Скажите боту: «Когда-нибудь хочу попробовать керамику» — идея подождёт здесь без сроков.", "bulb"));
          return;
        }
        family.ideas.forEach((idea) => {
          const card = FA.card("fact");
          card.append(FA.bdi(idea.title, "family-item-title"));
          if (idea.onlyMine) card.append(FA.onlyMineTag());
          else if (idea.mine) card.append(el("span", "tag", "моя"));
          const project = button("fact-action", "Сделать проектом", () => FA.askInChat("family-idea-project", (work) => FA.busy(project, work), card, projectNonce));
          project.setAttribute("aria-label", "Сделать проектом: " + idea.title);
          const row = el("div", "fact-actions");
          row.append(project);
          if (idea.mine && idea.onlyMine) {
            const share = button("fact-action", "Показать семье", () => FA.shareWithFamily(idea, share, card, list, draw));
            share.setAttribute("aria-label", "Показать семье: " + idea.title);
            row.append(share);
          }
          if (idea.mine) {
            const drop = button("fact-action", "Убрать", async () => {
              if (await FA.confirm("Убрать идею?", "Убрать", idea.title)) await remove(idea, drop, card, FA.nonce());
            });
            drop.setAttribute("aria-label", "Убрать: " + idea.title);
            row.append(drop);
          }
          row.classList.toggle("single", row.childElementCount === 1);
          row.classList.toggle("triple", row.childElementCount === 3);
          card.append(row);
          list.append(card);
        });
      }
      draw(first);
      // An idea is one's own until shown to the family: «Только мне» by default.
      ctx.main.set({
        onClick: () => FA.newKeptSheet({
          choices: [["personal", "Только мне"], ["family", "Вся семья"]],
          examples: ["Попробовать керамику", "Поход с палатками", "Научиться кататься на сапах"], kind: "idea",
          question: "Кто видит", redraw: draw,
          said: { family: "Идея записана — её видит вся семья", personal: "Идея записана — её видите только вы" },
          title: "Новая идея", visibility: "personal",
        }),
        text: "Новая идея",
      });
    },
  });

  const APPROACH = [
    { bot: "записывает и помогает выбрать следующий шаг", icon: "file", link: "https://gettingthingsdone.com/", method: "GTD", source: "Getting Things Done", title: "Всё из головы — в список, у каждого дела следующий шаг" },
    { bot: "хранит договорённость и ждёт согласия", icon: "people", link: "https://www.fairplaylife.com/", method: "Fair Play", source: "Fair Play", title: "Область ведёт один человек целиком, а не по галочкам" },
    { bot: "бережёт окно, другим видна только занятость", icon: "person", link: "https://www.fairplaylife.com/unicorn-space", method: "Unicorn Space", source: "Unicorn Space", title: "У каждого есть время для себя" },
    { bot: "помнит традиции и позволяет пропустить", icon: "heart", link: "https://www.gottman.com/", method: "Ритуалы связи", source: "Институт Готтмана", title: "Маленькие регулярные моменты вместе" },
  ];

  FA.screen("approach", {
    parent: "#family",
    parentLabel: "Семья",
    tab: "family",
    title: "Наш подход",
    render(view) {
      FA.header(view, { title: "Наш подход" });
      APPROACH.forEach((idea) => {
        const card = FA.card("fact approach-card");
        const head = el("div", "family-item-head");
        head.append(FA.icon(idea.icon, "family-item-icon"), el("h2", "family-item-title", idea.title));
        const facts = el("dl", "approach-facts");
        facts.append(el("dt", null, "Метод"), el("dd", null, idea.method), el("dt", null, "Как помогает бот"), el("dd", null, idea.bot));
        const source = button("link-button", "", () => FA.openLink(idea.link));
        source.append(el("span", null, "Источник: " + idea.source), FA.icon("external", "step-chevron"));
        card.append(head, facts, source);
        view.append(card);
      });
      const errors = el("div");
      const nonce = FA.nonce();
      const coach = button("link-button", "", () => FA.askInChat("coach-on", (work) => FA.busy(coach, work), errors, nonce));
      coach.append(el("span", null, "Включить вопросы коуча"), FA.icon("chevron-right", "step-chevron"));
      view.append(el("p", "footnote", "Чего бот не делает: не считает вклад, не сравнивает, не ставит оценки."), coach, errors);
    },
  });
})();
