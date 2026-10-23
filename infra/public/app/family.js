// «Семья»: how the family runs things, in four live cards (tasks, care areas, personal time, traditions)
// plus joint decisions, someday ideas and «Наш подход». No counts of anyone's contribution, no streaks,
// no scores (docs/telegram-mini-app-family-and-media.ru.md). This file holds the shared data and helpers
// and the home screen; the sections are in family-parts.js and family-more.js.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;

  /** One family read for every section; a change answers with the whole object again. */
  FA.family = {
    data: null,
    async get(force) {
      if (force || !this.data) this.data = await FA.get("/app-api/family");
      return this.data;
    },
    invalidate() {
      this.data = null;
    },
  };

  let changing = false;
  /**
   * One family change at a time: the answer redraws the whole section, so a second change sent meanwhile
   * would act on what is about to be replaced. The section's controls are locked while it is out, and
   * «Повторить» resends the same operation with the same nonce.
   * `run` wraps the request (the pressed control's busy state, or the main button's).
   */
  FA.familyChange = async function familyChange(options) {
    if (changing) return false;
    changing = true;
    const nonce = options.nonce || FA.nonce();
    if (options.lock) FA.lockForm(options.lock, true);
    let data = null;
    try {
      await options.run(async () => {
        data = await FA.post(options.path, options.body || null, nonce);
      });
    } catch (error) {
      changing = false;
      if (options.lock) FA.lockForm(options.lock, false);
      FA.haptic("error");
      if (error.status === 409) {
        FA.family.invalidate();
        FA.toast("Это уже изменили. Показываю, как сейчас.");
        FA.refresh();
      } else {
        FA.failed(error, options.place, () => familyChange({ ...options, nonce }));
      }
      return false;
    }
    changing = false;
    FA.family.data = data;
    FA.haptic("success");
    if (options.said) FA.toast(options.said);
    options.redraw(data);
    return true;
  };

  /** «Предложить традицию» and the like happen in the chat: the bot sends an example to send. */
  FA.askInChat = async function askInChat(id, run, place, nonce) {
    try {
      await run(() => FA.hint(id, nonce));
    } catch (error) {
      FA.failed(error, place, () => askInChat(id, run, place, nonce));
    }
  };

  /**
   * Today's marks on a tradition: mine («Отмечено вами») and the others' («Отметили: Юля»). `doneTodayBy`
   * names everyone who marked it today, me included, by first name, so my own name is taken out of it.
   */
  FA.traditionMarks = function traditionMarks(tradition, family) {
    const byMe = tradition.doneTodayByMe !== undefined ? tradition.doneTodayByMe : tradition.doneToday;
    const me = family && family.participants.find((person) => person.me);
    const myName = me ? String(me.name).split(" ")[0] : null;
    let others = (tradition.doneTodayBy || []).slice();
    if (byMe && myName) {
      const index = others.indexOf(myName);
      if (index !== -1) others.splice(index, 1);
    }
    const parts = [];
    if (byMe) parts.push("Отмечено вами");
    if (others.length > 0) parts.push("Отметили: " + others.join(", "));
    return { byMe, others, text: parts.length > 0 ? parts.join(" · ") : null };
  };

  /**
   * «Предложить традицию» / «Новая идея»: a sheet that writes it here, no detour through the chat.
   * `options`: { kind: "ritual"|"idea", title, examples, question, choices: [[value, label, note]], visibility
   * (preselected, or null to make the person choose), said: {family, personal}, redraw }. The choice is a list
   * of rows, not a toggle: the person's ordinary groups («Мама и Миша», «Квартира») join it as more rows once
   * read (`GRP-09`), and such a choice writes into that group.
   * The same name and choice are the same record: «Повторить» or a second press resends the nonce.
   */
  FA.newKeptSheet = function newKeptSheet(options) {
    const errors = el("div");
    const name = el("input", "text-input");
    name.id = "kept-title";
    name.maxLength = 200;
    name.autocomplete = "off";
    name.setAttribute("autofocus", "");
    const label = el("label", "field-caption", "Как назовём?");
    label.htmlFor = name.id;
    const examples = el("div", "chips kept-examples");
    options.examples.forEach((text) => examples.append(button("chip", text, () => {
      name.value = text;
      name.focus();
    })));
    const whoCaption = el("p", "field-caption", options.question);
    whoCaption.id = "kept-who";
    let chosen = options.visibility || null;
    const rows = el("div", "card kept-choices");
    rows.setAttribute("role", "radiogroup");
    rows.setAttribute("aria-labelledby", whoCaption.id);
    const choose = el("p", "kept-choose", "Выберите, с кем");
    const paint = () => {
      rows.querySelectorAll("[role=radio]").forEach((node, index) => {
        const on = node.dataset.value === chosen;
        node.setAttribute("aria-checked", String(on));
        node.tabIndex = on || (!chosen && index === 0) ? 0 : -1;
      });
      choose.hidden = Boolean(chosen);
      if (sheet) sheet.setMain({ disabled: !chosen, onClick: () => save(), text: "Записать" });
    };
    const addChoice = ([value, text, note]) => {
      const row = button("kept-choice", "", () => {
        chosen = value;
        FA.haptic("select");
        paint();
      });
      row.setAttribute("role", "radio");
      row.dataset.value = value;
      const words = el("span", "kept-choice-text");
      words.append(el("span", "kept-choice-label", text));
      if (note) words.append(el("span", "kept-choice-note", note));
      row.append(words, el("span", "kept-choice-mark"));
      // Arrow keys move the choice, as in any radio group.
      row.addEventListener("keydown", (event) => {
        const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const all = Array.from(rows.querySelectorAll("[role=radio]"));
        const next = all[(all.indexOf(row) + step + all.length) % all.length];
        next.click();
        next.focus();
      });
      rows.append(row);
    };
    options.choices.forEach(addChoice);
    // Groups arrive after the sheet opens; a slow or failed read only leaves them out.
    let groups = [];
    FA.myGroups().then((found) => {
      groups = found;
      found.forEach((group) => addChoice(["group:" + group.id, group.title, "Видят участники этой группы"]));
      paint();
    });
    let sheet = null;
    let last = null;
    sheet = FA.openSheet({
      build(body) {
        const form = el("div", "form");
        const titleBlock = el("div", "field-block");
        titleBlock.append(label, name, examples);
        const whoBlock = el("div", "field-block");
        whoBlock.append(whoCaption, rows, choose);
        form.append(titleBlock, whoBlock, errors);
        body.append(form);
      },
      main: { disabled: !chosen, onClick: () => save(), text: "Записать" },
      title: options.title,
    });
    paint();
    name.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        save();
      }
    });

    function save() {
      const title = name.value.trim();
      errors.replaceChildren();
      if (!title) {
        errors.append(FA.errorBox(new Error("Как назовём? Например: «" + options.examples[0] + "».")));
        name.focus();
        return;
      }
      if (!chosen) {
        choose.hidden = false;
        return;
      }
      // Always explicit: a tradition belongs to the people the person names, never to a guess.
      const group = chosen.startsWith("group:") ? groups.find((item) => "group:" + item.id === chosen) : null;
      const body = group ? { group, kind: options.kind, title } : { kind: options.kind, title, visibility: chosen };
      const key = JSON.stringify(body);
      if (!last || last.key !== key) last = { key, nonce: FA.nonce() };
      send(body, last.nonce);
    }

    function send(body, nonce) {
      return sheet.main.run(async () => {
        FA.lockForm(sheet.body, true);
        try {
          if (body.group) await FA.writeToGroup(body.group.id, { kind: body.kind, title: body.title }, nonce);
          else await FA.post("/app-api/tasks", body, nonce);
        } catch (error) {
          FA.lockForm(sheet.body, false);
          FA.failed(error, errors, error.status >= 400 && error.status < 500 ? null : () => send(body, nonce));
          return;
        }
        FA.haptic("success");
        FA.board.invalidate();
        sheet.close();
        FA.toast(body.group ? "Записала в группу «" + body.group.title + "»" : options.said[body.visibility]);
        options.redraw(await FA.family.get(true));
      });
    }
  };

  /** «Видите только вы»: a tradition or an idea written for its author alone (before they became the family's). */
  FA.onlyMineTag = function onlyMineTag() {
    const tag = el("span", "only-mine");
    tag.append(FA.icon("lock"), el("span", null, "Видите только вы"));
    return tag;
  };

  /**
   * «Показать семье»: the item becomes the family's, in place, through the task's own «share» (never back:
   * a tradition or an idea is not made personal again). One nonce per press, kept for «Повторить».
   */
  FA.shareWithFamily = function shareWithFamily(item, control, place, lock, redraw) {
    const nonce = FA.nonce();
    const attempt = async () => {
      if (lock) FA.lockForm(lock, true);
      try {
        await FA.busy(control, () => FA.taskAction(item.id, "share", item.version, null, nonce));
      } catch (error) {
        if (lock) FA.lockForm(lock, false);
        FA.failed(error, place, attempt);
        return;
      }
      FA.haptic("success");
      FA.toast("Теперь видит вся семья");
      FA.board.invalidate();
      redraw(await FA.family.get(true));
    };
    return attempt();
  };

  const WEEKDAY_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const WEEKDAY_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
  const compact = (time) => FA.clockText(time).replace(/:00$/u, "");

  /** «ср 19–21», «каждый день 7–8» */
  FA.windowShort = (window) => (window.weekday === null ? "каждый день" : WEEKDAY_SHORT[window.weekday]) + " " +
    compact(window.startsAt) + "–" + compact(window.endsAt);
  /** «Среда», «Каждый день» */
  FA.weekdayName = (weekday) => (weekday === null ? "Каждый день" : WEEKDAY_FULL[weekday]);
  FA.WEEKDAYS = [[null, "Каждый день"], [1, "пн"], [2, "вт"], [3, "ср"], [4, "чт"], [5, "пт"], [6, "сб"], [0, "вс"]];

  /** «12–18 октября»: the week (Monday to Sunday) of the given day. */
  function weekLabel(today) {
    const day = new Date(today + "T00:00:00Z").getUTCDay();
    const from = FA.addDays(today, -((day + 6) % 7));
    const until = FA.addDays(from, 6);
    return from.slice(5, 7) === until.slice(5, 7)
      ? Number(from.slice(8)) + "–" + FA.dayMonth(until)
      : FA.dayMonth(from) + " – " + FA.dayMonth(until);
  }

  /** A row of «На этой неделе»: who (a letter, or an icon for the family), when, what. */
  function weekRow(options) {
    const row = button("week-row", "", () => FA.go(options.go));
    const mark = options.name ? FA.avatar(options.name) : el("span", "avatar avatar-icon");
    if (!options.name) mark.append(FA.icon(options.icon));
    const text = el("span", "week-text");
    text.append(el("span", "week-when", options.when), FA.bdi(options.title, "week-title"));
    if (options.onlyMine) text.append(FA.onlyMineTag());
    row.append(mark, text, FA.icon("chevron-right", "nav-row-chevron"));
    return row;
  }

  function tile(icon, title, state, go) {
    const node = button("family-tile", "", go);
    node.append(FA.icon(icon, "family-tile-icon"), el("span", "family-tile-title", title));
    if (state) node.append(FA.bdi(state, "family-tile-state"));
    return node;
  }

  // «Пригласить в семью»: the bot answers in the chat with an example, inviting stays an owner's chat action.
  const INVITE_HINT = "family-invite";

  /** «Кто в семье и где общаемся»: the people, the family's group chats, and for the owner a way to add one. */
  function peopleAndChats(family, errors, groupsShown) {
    const card = FA.card("people-card");
    card.append(el("h2", "card-title", "Кто в семье и где общаемся"));
    const people = el("ul", "people-list");
    family.participants.forEach((person) => {
      const item = el("li", "person");
      // The whole name as the family wrote it: «Бабушка Галя» is not «Бабушка».
      item.append(FA.avatar(person.name), FA.bdi(String(person.name), "person-name"));
      if (person.me) item.append(el("span", "person-me", "вы"));
      people.append(item);
    });
    card.append(people);
    const chats = (family.chats && family.chats.groups) || [];
    const chatList = el("div", "chat-list");
    if (chats.length === 0) {
      chatList.append(el("p", "card-sub chat-none", "Семейного чата пока нет"));
    } else {
      chats.forEach((chat) => {
        const row = el("p", "chat-row");
        row.append(FA.icon("chat", "chat-icon"), FA.bdi(chat.title, "chat-title"));
        chatList.append(row);
      });
    }
    // With «Группы с Шушей» on the screen the family's chat is listed there; not twice.
    if (!groupsShown) card.append(chatList);
    const link = family.chats && family.chats.connectLink;
    if (link) {
      // Telegram's own picker: an existing group or a new one; the bot connects it as the family chat.
      const connect = button("secondary-button wide chat-connect", "", () => {
        if (FA.tg && typeof FA.tg.openTelegramLink === "function") FA.tg.openTelegramLink(link); else FA.openLink(link);
      });
      connect.append(FA.icon("chat"), el("span", null, "Создать или подключить семейный чат"));
      card.append(connect, el("p", "card-sub chat-note",
        "Telegram предложит выбрать группу или создать новую — бот подключит её сам. Сделайте бота администратором, чтобы он видел сообщения."));
    }
    if (INVITE_HINT) {
      const nonce = FA.nonce();
      const invite = button("link-button chat-invite", "Пригласить в семью", () => FA.askInChat(INVITE_HINT, (work) => FA.busy(invite, work), errors, nonce));
      card.append(invite);
    }
    return card;
  }

  FA.screen("family", {
    parent: null,
    tab: "family",
    title: "Семья",
    async render(view, _arg, ctx) {
      // Groups only behind their flag: with it off nothing is asked and nothing changes (the rollback).
      const [family, board, groups] = await FA.load(view, () => Promise.all([
        FA.family.get(true),
        FA.board.get(true).catch(() => null),
        FA.capabilities().then((caps) => (caps.groups ? FA.get("/app-api/groups").catch(() => null) : null)),
      ]));
      const today = board ? board.today : new Date().toISOString().slice(0, 10);
      FA.hero(view, { caption: "Наша неделя", lines: ["Хорошо", "быть вместе."], scene: "scene-family", shusha: "shusha-heart", sub: weekLabel(today) });
      const me = family.participants.find((person) => person.me);
      const errors = el("div");
      view.append(peopleAndChats(family, errors, Boolean(groups)));
      if (groups) view.append(FA.groupsCard(groups));

      // На этой неделе: traditions, personal time (of the others only that it is theirs), open decisions.
      const rows = [];
      family.traditions.forEach((tradition) => rows.push(weekRow({
        go: "#traditions", icon: "heart", onlyMine: tradition.onlyMine, title: tradition.title,
        when: FA.traditionMarks(tradition, family).text || (tradition.last ? "Было " + tradition.last : "Традиция"),
      })));
      family.time.mine.forEach((window) => rows.push(weekRow({
        go: "#time", name: me ? me.name : "?", title: window.title,
        when: FA.weekdayName(window.weekday) + " · " + FA.clockText(window.startsAt) + "–" + FA.clockText(window.endsAt),
      })));
      family.time.others.forEach((window) => rows.push(weekRow({
        go: "#time", name: window.name, title: window.name + " — время для себя",
        when: FA.weekdayName(window.weekday) + " · " + FA.clockText(window.startsAt) + "–" + FA.clockText(window.endsAt),
      })));
      const open = family.decisions.filter((decision) => decision.status === "open");
      open.forEach((decision) => rows.push(weekRow({
        go: "#decisions", icon: "scale", title: decision.title,
        when: !decision.isProposer && !decision.answered ? "Ждёт вашего ответа" : "Обсуждаем",
      })));
      const week = FA.card("week-card");
      week.append(el("h2", "card-title", "На этой неделе"));
      if (rows.length > 0) {
        const list = el("div", "week-list");
        list.append(...rows);
        week.append(list);
      } else {
        week.append(el("p", "card-sub week-quiet", "Пока ничего общего. Предложите традицию — бот спросит остальных."));
      }
      view.append(week);

      // Впереди: what waits for this person and is not already in «На этой неделе» (decisions are there):
      // an area offered to them, one row each, with its own answer.
      const mine = open.filter((decision) => !decision.isProposer && !decision.answered);
      const offered = family.areas.filter((area) => area.offeredToMe);
      if (offered.length > 0) {
        const ahead = FA.card("ahead-card");
        ahead.append(el("h2", "card-title", "Впереди"));
        offered.forEach((area) => {
          const row = el("div", "ahead-row");
          const text = el("div", "ahead-text");
          text.append(el("span", "week-when", "Вам предлагают вести"), FA.bdi(area.title, "week-title"));
          const buttons = el("div", "ahead-buttons");
          const answer = (action, control, said) => FA.familyChange({
            body: { version: area.version }, lock: ahead,
            path: "/app-api/family/areas/" + encodeURIComponent(area.id) + "/" + action, place: row,
            redraw: () => FA.refresh(), run: (work) => FA.busy(control, work), said,
          });
          const yes = button("pill", "Беру", () => answer("accept", yes, "Теперь вы ведёте: " + area.title));
          const no = button("pill pill-quiet", "Не сейчас", () => answer("decline", no, "Ответ передан"));
          yes.setAttribute("aria-label", "Беру: " + area.title);
          no.setAttribute("aria-label", "Не сейчас: " + area.title);
          buttons.append(yes, no);
          const mark = el("span", "avatar avatar-icon-area");
          mark.setAttribute("aria-hidden", "true");
          mark.append(FA.icon("home-heart"));
          row.append(mark, text, buttons);
          ahead.append(row);
        });
        view.append(ahead);
      }

      const approach = button("card approach-link", "", () => FA.go("#approach"));
      const leaf = el("span", "avatar avatar-1 approach-icon");
      leaf.append(FA.icon("leaf"));
      const approachText = el("span", "approach-text");
      approachText.append(el("span", "approach-title", "Наш подход"), el("span", "approach-sub", "Договариваемся, помогаем, бережём время друг друга."));
      approach.append(leaf, approachText, FA.icon("chevron-right", "nav-row-chevron"));
      view.append(approach);

      // The sections as compact tiles, each with its state in a few words and no counts of anyone's share.
      const rowsOf = (kind) => (board ? board.sections.filter((section) => section.kind === kind).reduce((n, section) => n + section.rows.length, 0) : 0);
      const unowned = rowsOf("unowned");
      const free = family.areas.filter((area) => !area.owner && !area.pendingOwner).length;
      const first = family.traditions[0];
      const waiting = mine.length;
      const grid = el("div", "family-tiles");
      grid.append(
        tile("checklist", "Дела", board ? board.open + " открыто" + (unowned > 0 ? "\n" + unowned + " ничьих" : "") : null, () => {
          if (unowned > 0) FA.uiSet("fold.unowned", true);
          FA.go("#board");
        }),
        tile("home-heart", "Области заботы", free > 0 ? "Есть свободная" : family.areas.length > 0 ? "Все при деле" : "Пока нет", () => FA.go("#areas")),
        tile("clock", "Личное время", family.time.mine.length > 0 ? "Ваше: " + family.time.mine.map(FA.windowShort).join(", ") : "Добавьте своё окно", () => FA.go("#time")),
        tile("calendar", "Традиции", first ? first.title : "Пока нет", () => FA.go("#traditions")),
        tile("scale", "Решить вместе", waiting > 0 ? waiting + " " + FA.plural(waiting, ["ждёт", "ждут", "ждут"]) + " ответа" : open.length > 0 ? "Обсуждаем: " + open.length : "Пока нет", () => FA.go("#decisions")),
        tile("bulb", "Когда-нибудь", family.ideas.length > 0 ? FA.count(family.ideas.length, ["идея", "идеи", "идей"]) : "Пока нет", () => FA.go("#someday")),
      );
      view.append(grid, errors);
      return FA.askBar(view, ctx);
    },
  });
})();
