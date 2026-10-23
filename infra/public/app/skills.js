// One scenario of the catalog (#skill/<id>): what comes out, how to ask, and «Попросить в чате». The catalog
// itself lives in «Создать» (studio.js) as «Ещё я умею»; nothing here writes, the only request is the hint.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el } = FA;

  async function visibleSkills() {
    const caps = await FA.capabilities();
    return FA.SKILLS.filter((skill) => !skill.needs || caps[skill.needs]);
  }

  FA.screen("skill", {
    parent: "#create",
    parentLabel: "Создать",
    tab: "create",
    title: "Сценарий",
    async render(view, id, ctx) {
      const skills = await FA.load(view, visibleSkills);
      const skill = skills.find((item) => item.id === id);
      if (!skill) {
        FA.header(view, { title: "Сценарий" });
        view.append(FA.empty("Такого сценария нет.", "Возможно, он недоступен на этом сервере.", "think"));
        return;
      }
      const header = FA.header(view, { title: skill.title });
      const hero = el("div", "skill-hero");
      hero.append(FA.icon(skill.icon, "skill-hero-icon"));
      header.prepend(hero);
      if (header.querySelector(".back-link")) header.prepend(header.querySelector(".back-link"));
      header.append(el("p", "page-subtitle", skill.result));

      view.append(FA.sectionTitle("Что получится"));
      const points = FA.card("points");
      const list = el("ul", "point-list");
      skill.points.forEach((point) => {
        const item = el("li", "point");
        item.append(FA.icon("check", "point-icon"), el("span", null, point));
        list.append(item);
      });
      points.append(list);
      view.append(points);

      view.append(FA.sectionTitle("Как попросить"));
      const chat = FA.card("bubbles");
      skill.examples.forEach((example) => chat.append(el("p", "bubble", example)));
      view.append(chat);
      const errors = el("div");
      view.append(errors, el("p", "footnote", "Бот пришлёт пример в чат — отправьте его или напишите по-своему."));

      // One request per visit: «Повторить» or a second tap after a lost answer resends the same nonce.
      const nonce = FA.nonce();
      const ask = () => ctx.main.run(async () => {
        errors.replaceChildren();
        try {
          await FA.hint(skill.hint || "skill-" + skill.id, nonce);
        } catch (error) {
          if (ctx.live()) FA.failed(error, errors, ask);
        }
      });
      ctx.main.set({ onClick: ask, text: "Попросить в чате" });
    },
  });
})();
