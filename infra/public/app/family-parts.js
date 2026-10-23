// «Семья» sections that change shared things: traditions («Было сегодня»), care areas (take, offer, let go,
// answer an offer) and joint decisions (answer). Every change answers with the whole family object, and the
// section is drawn again from it (FA.familyChange). Proposing something new happens in the chat.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;

  /** The main button «Предложить …»: a hint into the chat, one nonce per visit. */
  function proposeInChat(ctx, id, text, place) {
    const nonce = FA.nonce();
    ctx.main.set({ onClick: () => FA.askInChat(id, (work) => ctx.main.run(work), place, nonce), text });
  }

  function actionRow(...buttons) {
    const row = el("div", "fact-actions" + (buttons.length === 1 ? " single" : ""));
    row.append(...buttons);
    return row;
  }

  FA.screen("traditions", {
    parent: "#family",
    parentLabel: "Семья",
    tab: "family",
    title: "Традиции",
    async render(view, _arg, ctx) {
      FA.header(view, { title: "Традиции", subtitle: "Маленькие регулярные моменты вместе" });
      const first = await FA.load(view, () => FA.family.get(true));
      const list = el("div", "card-stack");
      const errors = el("div");
      view.append(list, errors, el("p", "footnote", "Пропустить или снять традицию можно в чате — без долга."));

      function draw(family) {
        list.replaceChildren();
        if (family.traditions.length === 0) {
          list.append(FA.empty("Традиций пока нет",
            "Например: настолки по средам, блины в воскресенье, прогулка после ужина. Предложите свою — бот спросит остальных.", "calendar"));
          return;
        }
        family.traditions.forEach((tradition) => {
          const card = FA.card("fact");
          const head = el("div", "family-item-head");
          head.append(FA.icon("calendar", "family-item-icon"));
          const text = el("div", "family-item-text");
          text.append(FA.bdi(tradition.title, "family-item-title"),
            el("span", "task-meta", tradition.last ? "было " + tradition.last : "ещё не было"));
          if (tradition.onlyMine) text.append(FA.onlyMineTag());
          head.append(text);
          card.append(head);
          // Written for the author alone (before traditions became the family's): they can show it to everyone.
          const share = tradition.mine && tradition.onlyMine
            ? button("fact-action", "Показать семье", () => FA.shareWithFamily(tradition, share, card, list, draw)) : null;
          if (share) share.setAttribute("aria-label", "Показать семье: " + tradition.title);
          // My own mark ends the day's question for me; someone else's mark is news, not a reason to hide the button.
          const marks = FA.traditionMarks(tradition, family);
          if (marks.others.length > 0 && !marks.byMe) text.append(el("span", "family-marked", "Отметили: " + marks.others.join(", ")));
          if (marks.byMe) {
            const done = el("p", "family-done");
            done.append(FA.icon("check-circle"), el("span", null, marks.text));
            card.append(done);
            if (share) card.append(actionRow(share));
          } else {
            const mark = button("fact-action", "Было сегодня", () => FA.familyChange({
              lock: list, path: "/app-api/family/traditions/" + encodeURIComponent(tradition.id) + "/done", place: card,
              redraw: draw, run: (work) => FA.busy(mark, work), said: "Отмечено: " + tradition.title,
            }));
            mark.setAttribute("aria-label", "Было сегодня: " + tradition.title);
            card.append(share ? actionRow(mark, share) : actionRow(mark));
          }
          list.append(card);
        });
      }
      draw(first);
      ctx.main.set({
        // No preselected circle: a tradition with one's mother is not the spouse's. The person always says whose.
        onClick: () => FA.newKeptSheet({
          // A tradition with some of the family (with mother) is a group's: those come next, by their own names.
          choices: [["personal", "Моя", "Видите только вы"], ["family", "Вся семья", "Её увидят все в семье"]],
          examples: ["Ужин без телефонов", "Блины по воскресеньям", "Прогулка после ужина"], kind: "ritual",
          question: "С кем эта традиция?", redraw: draw,
          said: { family: "Традиция записана — её видит вся семья", personal: "Традиция записана — её видите только вы" },
          title: "Новая традиция", visibility: null,
        }),
        text: "Предложить традицию",
      });
    },
  });

  FA.screen("areas", {
    parent: "#family",
    parentLabel: "Семья",
    tab: "family",
    title: "Области заботы",
    async render(view, _arg, ctx) {
      FA.header(view, { subtitle: "Область ведут целиком: замечают, планируют и делают.", title: "Области заботы" });
      const first = await FA.load(view, () => FA.family.get(true));
      const list = el("div", "card-stack");
      const errors = el("div");
      view.append(list, errors);

      function change(area, action, control, card, said, extra) {
        return FA.familyChange({
          body: { version: area.version, ...(extra || {}) }, lock: list,
          path: "/app-api/family/areas/" + encodeURIComponent(area.id) + "/" + action, place: card,
          redraw: draw, run: (work) => FA.busy(control, work), said,
        });
      }

      /** «Предложить…»: whom, among the other adults (a child is not asked to lead an area); it waits for their «Беру». */
      function offer(area, card, family) {
        const others = family.participants.filter((person) => !person.me && !person.child);
        const sheet = FA.openSheet({
          build(body) {
            body.append(el("p", "sheet-text", "Область перейдёт к человеку, когда он согласится."));
            const errorsHere = el("div");
            others.forEach((person) => {
              const pick = button("secondary-button wide sheet-choice", person.name, async () => {
                FA.lockForm(body, true);
                const ok = await FA.familyChange({
                  body: { ownerRef: person.ref, version: area.version }, path: "/app-api/family/areas/" + encodeURIComponent(area.id) + "/propose",
                  place: errorsHere, redraw: draw, run: (work) => FA.busy(pick, work), said: "Предложение отправлено",
                });
                if (ok) sheet.close(); else FA.lockForm(body, false);
              });
              body.append(pick);
            });
            body.append(errorsHere);
          },
          title: "Кому предложить «" + area.title + "»?",
        });
      }

      function draw(family) {
        list.replaceChildren();
        if (family.areas.length === 0) {
          list.append(FA.empty("Областей пока нет",
            "Например: машина — ТО, шины, страховка; садик — общение, вещи, справки. Заведите первую в чате.", "home-heart"));
          return;
        }
        const others = family.participants.filter((person) => !person.me && !person.child);
        family.areas.forEach((area) => {
          const card = FA.card("fact");
          const head = el("div", "family-item-head");
          head.append(FA.icon("home-heart", "family-item-icon"));
          const text = el("div", "family-item-text");
          const who = area.owner ? "ведёт " + area.owner : "пока никто";
          text.append(FA.bdi(area.title, "family-item-title"), FA.bdi(who, "task-meta"));
          if (area.pendingOwner && !area.offeredToMe) text.append(FA.bdi("ждёт согласия: " + area.pendingOwner, "task-meta"));
          if (area.offeredToMe) text.append(el("span", "family-offer", "Вам предлагают вести эту область"));
          if (area.details) text.append(FA.bdi("Что входит: " + area.details, "family-item-details"));
          head.append(text);
          card.append(head);
          const buttons = [];
          if (area.offeredToMe) {
            const yes = button("fact-action", "Беру", () => change(area, "accept", yes, card, "Теперь вы ведёте: " + area.title));
            const no = button("fact-action", "Не сейчас", () => change(area, "decline", no, card, "Ответ передан"));
            buttons.push(yes, no);
          } else if (!area.owner && !area.pendingOwner) {
            const take = button("fact-action", "Беру", () => change(area, "claim", take, card, "Теперь вы ведёте: " + area.title));
            buttons.push(take);
            if (others.length > 0) buttons.push(button("fact-action", "Предложить…", () => offer(area, card, family)));
          } else if (area.mine && !area.pendingOwner) {
            if (others.length > 0) buttons.push(button("fact-action", "Передать…", () => offer(area, card, family)));
            const free = button("fact-action", "Отпустить", async () => {
              if (await FA.confirm("Отпустить область?", "Отпустить", "Она станет ничьей; её дела останутся.")) {
                await change(area, "release", free, card, "Область свободна");
              }
            });
            buttons.push(free);
          } else if (area.pendingOwner) {
            card.append(el("p", "family-note", "Предложение отправлено"));
          }
          buttons.forEach((node) => node.setAttribute("aria-label", node.textContent + ": " + area.title));
          if (buttons.length > 0) card.append(actionRow(...buttons));
          list.append(card);
        });
      }
      draw(first);
      proposeInChat(ctx, "family-area", "Новая область", errors);
    },
  });

  const CHOICE = { agree: "за", decline: "не сейчас" };

  FA.screen("decisions", {
    parent: "#family",
    parentLabel: "Семья",
    tab: "family",
    title: "Решить вместе",
    async render(view, _arg, ctx) {
      FA.header(view, { title: "Решить вместе" });
      const first = await FA.load(view, () => FA.family.get(true));
      const body = el("div");
      const errors = el("div");
      view.append(body, errors);

      function decisionCard(decision) {
        const card = FA.card("fact");
        card.append(FA.bdi(decision.title, "family-item-title"));
        if (decision.isProposer) card.append(el("p", "task-meta", "Вы предложили"));
        decision.answers.forEach((answer) => {
          card.append(FA.bdi((answer.isYou ? "Вы" : answer.name) + ": " + (CHOICE[answer.choice] || answer.choice), "family-answer"));
        });
        if (decision.status === "agreed") {
          const done = el("p", "family-done");
          done.append(FA.icon("check"), el("span", null, "Все согласны"));
          card.append(done);
          return card;
        }
        if (decision.status !== "open") return card;
        card.append(el("p", "family-note", "Молчание не считается согласием"));
        if (!decision.isProposer && !decision.answered) {
          const answer = (choice, control) => FA.familyChange({
            body: { choice, version: decision.version }, lock: body,
            path: "/app-api/family/decisions/" + encodeURIComponent(decision.id) + "/answer", place: card,
            redraw: draw, run: (work) => FA.busy(control, work), said: "Ответ записан",
          });
          const yes = button("primary-button", "Я за", () => answer("agree", yes));
          const no = button("secondary-button", "Не сейчас", () => answer("decline", no));
          const row = el("div", "decision-buttons");
          row.append(yes, no);
          card.append(row);
        } else {
          card.append(el("p", "task-meta", "Ждём ответа остальных"));
        }
        return card;
      }

      function draw(family) {
        body.replaceChildren();
        const open = family.decisions.filter((decision) => decision.status === "open");
        const agreed = family.decisions.filter((decision) => decision.status === "agreed");
        const other = family.decisions.filter((decision) => decision.status !== "open" && decision.status !== "agreed");
        if (family.decisions.length === 0) {
          body.append(FA.empty("Решений пока нет", "Например: «Предлагаю: в воскресенье идём в парк». Бот спросит каждого и ничего не решит за молчащих.", "scale"));
          return;
        }
        [["Ждут ответа", open], ["Приняты", agreed], ["Не приняты", other]].forEach(([title, items]) => {
          if (items.length === 0) return;
          body.append(FA.sectionTitle(title));
          const stack = el("div", "card-stack");
          items.forEach((decision) => stack.append(decisionCard(decision)));
          body.append(stack);
        });
      }
      draw(first);
      proposeInChat(ctx, "family-decision", "Предложить решение", errors);
    },
  });
})();
