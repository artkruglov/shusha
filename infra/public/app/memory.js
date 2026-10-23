// «Что бот обо мне помнит»: the person's saved facts, the message each came from, and «Удалить».
// A fix needs a source message (memoryRepository.updateByRef), so «Изменить» sends a hint into the chat
// instead of editing here. The search filters what is already loaded; it does not query the server.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;

  function sourceBlock(item, holder, toggle) {
    return async () => {
      const open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      holder.hidden = open;
      if (open || holder.dataset.loaded) return;
      holder.replaceChildren(el("p", "status", "Загружаю источник…"));
      try {
        const source = await FA.get("/app-api/memory/" + encodeURIComponent(item.ref) + "/source");
        holder.dataset.loaded = "1";
        const when = FA.fullDate(source.observedAt);
        holder.replaceChildren(el("p", "source-meta", [source.author, source.chat, when].filter(Boolean).join(" · ")));
        if (source.snippet) holder.append(FA.bdi(source.snippet, "source-quote"));
        if (source.link) holder.append(button("link-button", "Открыть сообщение", () => FA.openLink(source.link)));
      } catch (error) {
        if (error.status === 404) {
          holder.dataset.loaded = "1";
          holder.replaceChildren(el("p", "source-meta", "Источник: сообщение недоступно"));
        } else {
          holder.replaceChildren(FA.errorBox(error, () => {
            toggle.setAttribute("aria-expanded", "false");
            toggle.click();
          }));
        }
      }
    };
  }

  function factCard(item, onGone) {
    const card = FA.card("fact");
    card.append(FA.bdi(item.content, "fact-text"));
    const meta = el("div", "fact-meta");
    const date = FA.fullDate(item.at);
    if (date) meta.append(el("span", null, date));
    const toggle = button("link-button source-toggle", "Источник");
    const holder = el("div", "source");
    holder.id = "source-" + item.ref.replace(/[^A-Za-z0-9_-]/gu, "");
    holder.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", holder.id);
    toggle.addEventListener("click", sourceBlock(item, holder, toggle));
    meta.append(toggle);
    card.append(meta, holder);

    const actions = el("div", "fact-actions");
    const edit = button("fact-action", "", () => FA.hintSheet("memory-edit"));
    edit.append(FA.icon("edit"), el("span", null, "Изменить"));
    // «Повторить» resends this deletion with its nonce, without asking again: the person already agreed.
    const forget = (nonce) => FA.busy(remove, async () => {
      try {
        await FA.post("/app-api/memory/" + encodeURIComponent(item.ref) + "/forget", null, nonce);
        FA.haptic("success");
        card.remove();
        FA.toast("Сведение удалено");
        onGone();
      } catch (error) {
        FA.failed(error, card, () => forget(nonce));
      }
    });
    const remove = button("fact-action danger", "", async () => {
      if (await FA.confirm("Удалить это сведение?", "Удалить")) await forget(FA.nonce());
    });
    remove.append(FA.icon("trash"), el("span", null, "Удалить"));
    edit.setAttribute("aria-label", "Изменить: " + item.content.slice(0, 60));
    remove.setAttribute("aria-label", "Удалить: " + item.content.slice(0, 60));
    actions.append(edit, remove);
    card.append(actions);
    card.dataset.text = item.content.toLocaleLowerCase("ru");
    return card;
  }

  FA.screen("memory", {
    parent: "#more",
    parentLabel: "Ещё",
    tab: "more",
    title: "Что бот обо мне помнит",
    async render(view) {
      FA.header(view, { shusha: "shusha-glasses", subtitle: "Личные сведения · видно только вам", title: "Что бот обо мне помнит" });
      const first = await FA.load(view, () => FA.get("/app-api/memory"));
      const search = el("div", "search");
      const input = el("input", "search-input");
      input.type = "search";
      input.placeholder = "Поиск по сведениям";
      input.setAttribute("aria-label", "Поиск по сведениям");
      search.append(FA.icon("search", "search-icon"), input);
      const list = el("div", "card-stack");
      const nothing = el("p", "status", "Ничего не нашлось.");
      nothing.hidden = true;
      const moreBox = el("div", "more-box");
      const empty = FA.empty("Бот пока ничего о вас не запомнил", "Скажите в чате «Запомни: …», и сведение появится здесь.", "bookmark");

      function filter() {
        const query = input.value.trim().toLocaleLowerCase("ru");
        let shown = 0;
        list.querySelectorAll(".fact").forEach((card) => {
          const match = !query || card.dataset.text.indexOf(query) !== -1;
          card.hidden = !match;
          if (match) shown += 1;
        });
        nothing.hidden = shown > 0 || list.childElementCount === 0;
      }
      function afterRemove() {
        if (list.childElementCount === 0 && moreBox.childElementCount === 0) {
          search.hidden = true;
          list.replaceWith(empty);
        }
        filter();
      }
      function add(page) {
        page.items.forEach((item) => list.append(factCard(item, afterRemove)));
        moreBox.replaceChildren();
        if (page.nextCursor) {
          const more = button("secondary-button wide", "Ещё", async () => {
            await FA.busy(more, async () => {
              try {
                add(await FA.get("/app-api/memory?cursor=" + encodeURIComponent(page.nextCursor)));
              } catch (error) {
                FA.failed(error, moreBox, () => more.click());
              }
            });
          });
          moreBox.append(more);
        }
        filter();
      }
      input.addEventListener("input", filter);
      if (first.items.length === 0) {
        view.append(empty);
        return;
      }
      view.append(search, list, nothing, moreBox);
      add(first);
      view.append(el("p", "footnote", "Здесь только сохранённые сведения. Любое можно удалить, а исправить — в чате."));
    },
  });
})();
