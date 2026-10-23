// «Знакомство с Юной» (docs/service/pm/onboarding-quest.ru.md): a small ring on the «Сегодня» hero, not a block of
// the board. A tap opens the steps; an open step sends its card and phrase to the chat and closes the app, so the
// person tries it where it really works. The ring goes away when every step is done or the person hides it.
// `home.quest` (from /app-api/home): {done, total, steps: [{number, title, done}]}, absent when there is no quest.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;

  function ring(done, total) {
    const box = el("span", "quest-ring");
    box.style.setProperty("--quest-share", String(total > 0 ? done / total : 0));
    box.setAttribute("aria-hidden", "true");
    return box;
  }

  function sheet(quest, pill) {
    FA.openSheet({
      title: "Знакомство с " + FA.Agent("instrumental"),
      build(body, handle) {
        body.append(el("p", "quest-lead", "Попробуйте по одному: каждое действие займёт минуту. Уже получилось " + quest.done + " из " + quest.total + "."));
        const list = el("ol", "quest-steps");
        let offered = false;
        quest.steps.forEach((step, index) => {
          const item = el("li", "quest-step" + (step.done ? " is-done" : ""));
          const mark = el("span", "quest-mark");
          // The position, not the step's fixed number: a member's list skips the owner-only steps.
          mark.append(step.done ? FA.icon("check") : document.createTextNode(String(index + 1)));
          item.append(mark, el("span", "quest-title", step.title));
          // Only the first open step gets the button: one next thing, not a menu of every step.
          if (!step.done && !offered) {
            offered = true;
            item.append(button("primary-button quest-try", "Попробовать в чате", async () => {
              await FA.post("/app-api/quest/try", { step: step.number });
              handle.close();
              if (FA.tg && typeof FA.tg.close === "function") FA.tg.close();
            }));
          }
          list.append(item);
        });
        body.append(list, button("link-button quest-hide", "Скрыть", async () => {
          await FA.post("/app-api/quest/hide", {});
          pill.remove();
          handle.close();
        }));
      },
    });
  }

  /** Puts the ring on the hero when there is a quest with something left to try. */
  FA.questPill = function questPill(hero, quest) {
    if (!quest || !Array.isArray(quest.steps) || quest.done >= quest.total) return;
    const pill = button("quest-pill", "", () => sheet(quest, pill));
    pill.setAttribute("aria-label", "Знакомство: " + quest.done + " из " + quest.total);
    pill.append(ring(quest.done, quest.total), el("span", "quest-pill-text", "Знакомство " + quest.done + "/" + quest.total), FA.icon("chevron-right", "quest-pill-chevron"));
    // Under the greeting, in the text column: a corner pill covered a two-line sub on narrow phones.
    (hero.querySelector(".hero-text") || hero).append(pill);
  };
})();
