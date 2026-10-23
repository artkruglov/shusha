// «Группы с Шушей» (behind capabilities.groups): the chats Шуша lives in besides the family's own, each with its
// own tasks and traditions. A group's task can be taken or closed here; everything else changes in its chat. The
// owner of an ordinary group gets «Позвать людей»: a join-request link to forward, Шуша greets whoever asks. With
// the flag off there is no card, no link and no request — that is the rollback.
"use strict";

(function () {
  const FA = window.FamilyApp;

  /** «сб, 24 октября» for a day, «21 октября в 18:00» for a moment: the server sends both as they are stored. */
  function whenText(value) {
    if (!value) return null;
    if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
      return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC", weekday: "short" })
        .format(new Date(value + "T00:00:00Z"));
    }
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return null;
    return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(at) + " в "
      + new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(at);
  }
  const { el, button } = FA;

  const TRADITIONS = ["традиция", "традиции", "традиций"];

  /**
   * Ordinary groups the person is in now, for «С кем?» and «Кто видит» (`GRP-09`): one read per page view. The
   * family's own group is not a choice there: «Для семьи» already is. Unreadable or switched off means none.
   */
  FA.myGroups = async function myGroups() {
    try {
      const caps = await FA.capabilities();
      if (!caps.groups) return [];
      const data = await FA.get("/app-api/groups");
      return data.groups.filter((group) => group.writable).map((group) => ({ id: group.id, title: group.title }));
    } catch {
      return [];
    }
  };

  /** Writes a task, a tradition or an idea into one ordinary group; the server checks the person is in its chat. */
  FA.writeToGroup = (groupId, body, nonce) =>
    FA.post("/app-api/groups/" + encodeURIComponent(groupId) + "/tasks", body, nonce);
  // `more`: the server stopped counting, the number is a floor: «100+ дел».
  // A floor of zero says nothing, so that count is left out rather than shown as «0+».
  const counted = (n, forms, more) => (!more ? FA.count(n, forms) : n > 0 ? n + "+ " + forms[2] : "");

  /** The groups card on «Семья»: one row per group, and for the owner a way to start one. */
  FA.groupsCard = function groupsCard(data) {
    const card = FA.card("groups-card");
    card.append(el("h2", "card-title", "Группы с " + FA.agent("instrumental")));
    if (data.groups.length === 0) {
      card.append(el("p", "card-sub groups-none", "Пока нет групп"));
    } else {
      const list = el("div", "week-list");
      data.groups.forEach((group) => {
        const row = button("week-row group-row", "", () => FA.go("#group/" + encodeURIComponent(group.id)));
        const mark = el("span", "avatar avatar-icon");
        mark.setAttribute("aria-hidden", "true");
        mark.append(FA.icon("chat"));
        const text = el("span", "week-text");
        const top = el("span", "group-top");
        top.append(FA.bdi(group.title, "week-title"));
        if (group.kind === "family") top.append(el("span", "tag group-kind", "Семья"));
        text.append(top, el("span", "week-when", [counted(group.openTasks, FA.TASKS, group.more), counted(group.traditions, TRADITIONS, group.more)].filter(Boolean).join(" · ")));
        row.append(mark, text, FA.icon("chevron-right", "nav-row-chevron"));
        list.append(row);
      });
      card.append(list);
    }
    // Some groups did not answer in time and are left out, not shown as empty.
    if (data.partial) card.append(el("p", "card-sub groups-partial", "Часть групп не ответила — откройте позже."));
    if (data.createLink) {
      const link = data.createLink;
      const create = button("secondary-button wide chat-connect", "", () => {
        if (FA.tg && typeof FA.tg.openTelegramLink === "function") FA.tg.openTelegramLink(link); else FA.openLink(link);
      });
      create.append(FA.icon("plus"), el("span", null, "Создать группу"));
      card.append(create, el("p", "card-sub chat-note",
        "Telegram предложит создать новую группу или выбрать свою. " + FA.Agent() + " станет администратором, у группы будут свои дела и традиции — личного и семейного она не видит."));
    }
    return card;
  };

  const ACTION_LABEL = { claim: "Беру", complete: "Сделано" };
  const ACTION_SAID = { claim: "Взяли: ", complete: "Готово: " };
  let acting = false;

  /** One tap on a group's task; a refused change (taken by someone else meanwhile) re-reads the page. */
  async function act(groupId, task, action, place, nonce = FA.nonce()) {
    if (acting) return;
    acting = true;
    try {
      await FA.post("/app-api/groups/" + encodeURIComponent(groupId) + "/tasks/" + encodeURIComponent(task.id) + "/" + action,
        { version: task.version }, nonce);
      FA.haptic("success");
      FA.toast(ACTION_SAID[action] + task.title);
      FA.board.invalidate();
      if (FA.family) FA.family.invalidate();
      FA.refresh();
    } catch (error) {
      if (error.status === 409 || error.status === 404) {
        FA.haptic("error");
        FA.toast("Это дело уже изменили. Показываю, как сейчас.");
        FA.refresh();
      } else {
        FA.failed(error, place, () => act(groupId, task, action, place, nonce));
      }
    } finally {
      acting = false;
    }
  }

  /** The owner's «Позвать людей»: a fresh join-request link into Telegram's share sheet. */
  async function invite(groupId, title, place) {
    if (acting) return;
    acting = true;
    try {
      const { link } = await FA.post("/app-api/groups/" + encodeURIComponent(groupId) + "/invite", {});
      const share = "https://t.me/share/url?url=" + encodeURIComponent(link) +
        "&text=" + encodeURIComponent("Зову вас в группу «" + title + "»");
      if (FA.tg && typeof FA.tg.openTelegramLink === "function") FA.tg.openTelegramLink(share); else FA.openLink(share);
    } catch (error) {
      FA.failed(error, place, () => invite(groupId, title, place));
    } finally {
      acting = false;
    }
  }

  function section(title, rows, quiet) {
    const box = el("section", "board-block");
    box.append(FA.sectionTitle(title));
    if (rows.length === 0) {
      box.append(el("p", "quiet-card", quiet));
      return box;
    }
    const card = FA.card("group-list");
    rows.forEach((row) => {
      const item = el("div", "group-item");
      item.append(FA.bdi(row.title, "group-item-title"));
      if (row.meta) item.append(el("span", "task-meta", row.meta));
      if (row.actions && row.actions.length > 0) {
        const actions = el("div", "chips group-item-actions");
        row.actions.forEach((action) => actions.append(button("chip-button", ACTION_LABEL[action], () => row.act(action, item))));
        item.append(actions);
      }
      card.append(item);
    });
    box.append(card);
    return box;
  }

  FA.screen("group", {
    parent: "#family",
    parentLabel: "Семья",
    tab: "family",
    title: "Группа",
    async render(view, id) {
      const caps = await FA.capabilities();
      if (!caps.groups) {
        FA.header(view, { title: "Группа" });
        view.append(FA.empty("Группы пока недоступны.", null, "think"));
        return;
      }
      let group;
      try {
        group = await FA.load(view, () => FA.get("/app-api/groups/" + encodeURIComponent(id)));
      } catch (error) {
        if (error.status !== 404 || !view.isConnected) throw error;
        // FA.load already put its error box; a group one has left is a calm state, not an error.
        view.replaceChildren();
        FA.header(view, { title: "Группа" });
        view.append(FA.empty("Этой группы больше нет у вас.", "Возможно, вас убрали из неё или её удалили.", "think"),
          button("link-button calm-link", "‹ Семья", () => FA.go("#family")));
        return;
      }
      const header = FA.header(view, { subtitle: group.kind === "family" ? "Семейная группа" : "Группа", title: group.title });
      header.querySelector(".page-title").prepend(FA.icon("chat", "group-title-icon"));
      if (group.tasks.length === 0 && group.traditions.length === 0) {
        view.append(FA.empty("В группе пока тихо.", group.writable
          ? "Запишите первое дело здесь или в чате группы."
          : "Дела и традиции появятся, когда их запишут в чате группы."));
      } else {
        view.append(
          section("Дела", group.tasks.map((task) => ({
            act: (action, place) => act(id, task, action, place),
            actions: task.actions || [],
            meta: [whenText(task.due), task.assignee || "Ничьё"].filter(Boolean).join(" · ") || null, title: task.title,
          })), "Открытых дел нет."),
          section("Традиции", group.traditions.map((tradition) => ({
            meta: tradition.last ? "Было " + whenText(tradition.last) : "Ещё не было", title: tradition.title,
          })), "Традиций пока нет."),
        );
      }
      if (group.truncated) view.append(el("p", "footnote", "Показана часть — остальное в чате группы."));
      // «+ Дело» right here: the form comes with this group chosen, a day and «Кому» from the people of its chat.
      if (group.writable) {
        const add = button("secondary-button wide", "", () => FA.go("#add/" + encodeURIComponent(id)));
        add.append(FA.icon("plus"), el("span", null, "Дело в группу"));
        view.append(add);
      }
      if (group.canInvite) {
        const box = el("section", "board-block group-invite");
        const call = button("secondary-button wide chat-connect", "", () => invite(id, group.title, box));
        call.append(FA.icon("plus"), el("span", null, "Позвать людей"));
        box.append(call, el("p", "card-sub chat-note",
          FA.Agent() + " даст ссылку, которую можно переслать. Каждого, кто по ней попросится, она встретит в личке: своих из семьи пустит сама, про остальных спросит вас."));
        view.append(box);
      }
      view.append(el("p", "footnote", "Проекты и остальное в группе меняются в её чате."));
    },
  });
})();
