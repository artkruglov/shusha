// «Новое дело» (#add): a title, a day, a project, who does it and who sees it. After «Добавить» the page
// stays open for the next one (fast capture); «Готово» goes back to the board. `#add/<group id>` (the group's
// «+ Дело») comes with that group chosen.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;
  const dayOf = (to, day) => FA.dayOf(to, day);
  const dateInput = (day, id) => FA.dateInput(day, id);

  /**
   * «Кому» for a group's task: me, whoever takes it, or someone Шуша has seen in its chat (`GET /app-api/groups/:id`,
   * read once per group). Unreadable people leave «Мне» and «Кто возьмёт»; the server checks the chat again.
   */
  function groupPeople() {
    const node = el("div", "field-block");
    node.hidden = true;
    const read = new Map();
    let choice = "me";
    let people = [];
    let shown = null;
    async function show(group) {
      shown = group ? group.id : null;
      node.hidden = !group;
      if (!group) return;
      if (!read.has(group.id)) {
        read.set(group.id, FA.get("/app-api/groups/" + encodeURIComponent(group.id))
          .then((data) => data.participants.filter((person) => !person.me)).catch(() => []));
      }
      const found = await read.get(group.id);
      if (shown !== group.id) return;
      people = found;
      choice = "me";
      const caption = el("p", "field-caption", "Кому");
      caption.id = "add-group-to";
      const to = FA.radioGroup({
        labelledBy: caption.id,
        onChange: (value) => { choice = value; },
        options: [["me", "Мне"], ["anyone", "Кто возьмёт"], ...people.map((person) => [person.ref, person.name])],
        value: choice,
      });
      to.node.classList.add("segments-wrap");
      node.replaceChildren(caption, to.node);
    }
    return {
      body: () => (choice === "anyone" ? { unassigned: true } : choice === "me" ? {} : { assigneeRef: choice }),
      node,
      person: () => people.find((person) => person.ref === choice) || null,
      show,
    };
  }

  FA.screen("add", {
    parent: "#board",
    parentLabel: "Сегодня",
    tab: "board",
    title: "Новое дело",
    async render(view, arg, ctx) {
      FA.header(view, { title: "Новое дело" });
      // Settings only for the default visibility, participants only for «Кому»: either unreadable leaves
      // its part at the safe default (never chosen; only «Мне»).
      const [board, settings, people, groups] = await FA.load(view, () => Promise.all([
        FA.board.get(),
        FA.get("/app-api/settings").catch(() => null),
        FA.get("/app-api/participants").catch(() => null),
        FA.myGroups(),
      ]));
      const saved = settings && settings.defaultVisibility ? settings.defaultVisibility : null;
      const others = people ? people.participants.filter((person) => !person.me) : [];
      const form = el("div", "form");
      const titleBlock = el("div", "field-block");
      const titleLabel = el("label", "field-caption", "Название");
      const title = el("input", "text-input");
      title.id = "add-title";
      title.maxLength = 300;
      title.autocomplete = "off";
      title.enterKeyHint = "done";
      titleLabel.htmlFor = title.id;
      titleBlock.append(titleLabel, title);
      // «Дело» in the composer on «Сегодня» brings its text here.
      if (FA.addDraft) {
        title.value = FA.addDraft;
        FA.addDraft = "";
      }

      let dueOn = null;
      const dueBlock = el("div", "field-block");
      const dueCaption = el("p", "field-caption", "Срок");
      dueCaption.id = "add-due";
      const chips = el("div", "chips");
      chips.setAttribute("role", "group");
      chips.setAttribute("aria-labelledby", dueCaption.id);
      const dueNote = el("p", "field-note");
      dueNote.setAttribute("aria-live", "polite");
      const date = dateInput(board.today, "add-date");
      date.setAttribute("aria-label", "Дата");
      date.hidden = true;
      const setDue = (value) => {
        dueOn = value || null;
        dueNote.textContent = dueOn ? "Срок: " + FA.longDate(dueOn) : "Без срока";
      };
      [["Сегодня", "today"], ["Завтра", "tomorrow"], ["Выходные", "weekend"], ["Дата", "date"]].forEach(([label, to]) => {
        const chip = button("chip", "", () => {
          const on = chip.getAttribute("aria-pressed") !== "true";
          chips.querySelectorAll(".chip").forEach((other) => other.setAttribute("aria-pressed", "false"));
          chip.setAttribute("aria-pressed", String(on));
          date.hidden = !(on && to === "date");
          if (!on) setDue(null);
          else if (to === "date") {
            date.focus();
            setDue(date.value);
          } else setDue(dayOf(to, board.today));
        });
        if (to === "date") chip.append(FA.icon("calendar"));
        chip.append(el("span", null, label));
        chip.setAttribute("aria-pressed", "false");
        chips.append(chip);
      });
      date.addEventListener("change", () => setDue(date.value));
      setDue(null);
      dueBlock.append(dueCaption, chips, date, dueNote);

      // «Кому»: me, or another adult of the family (a request with «Беру / Не могу»). An unowned task is a
      // conversation in the chat, not a chip here.
      const whoBlock = el("div", "field-block");
      const whoCaption = el("p", "field-caption", "Кто видит");
      whoCaption.id = "add-who";
      let whoChoice = arg && groups.some((group) => group.id === arg) ? "group:" + arg : saved || "personal";
      // Sent only once the person picks it here: the server keeps the first explicit choice as their default,
      // so a preselected value they never touched must not become one.
      let whoTouched = false;
      // A group the person is in now writes the task into that group's chat area (`GRP-09`): a day, and «Кому» from
      // the people of its chat; its projects are settled in the chat, so the project steps aside.
      const groupOf = (value) => (value.startsWith("group:") ? groups.find((group) => "group:" + group.id === value) : null);
      const applyWho = () => {
        const group = groupOf(whoChoice);
        toBlock.hidden = Boolean(group);
        list.hidden = Boolean(group);
        groupTo.show(group);
      };
      const who = FA.radioGroup({
        labelledBy: whoCaption.id,
        onChange: (value) => {
          whoChoice = value;
          whoTouched = true;
          applyWho();
        },
        options: [["family", "Для семьи"], ["personal", "Только мне"], ...groups.map((group) => ["group:" + group.id, group.title])],
        value: whoChoice,
      });
      if (groups.length > 0) who.node.classList.add("segments-wrap");
      const whoNote = el("p", "field-note", "Поручение видят оба");
      whoNote.hidden = true;
      whoBlock.append(whoCaption, who.node, whoNote);

      let assignee = null;
      const toBlock = el("div", "field-block");
      if (others.length > 0) {
        const toCaption = el("p", "field-caption", "Кому");
        toCaption.id = "add-to";
        const to = FA.radioGroup({
          labelledBy: toCaption.id,
          onChange(ref) {
            assignee = ref === "me" ? null : others.find((person) => person.ref === ref);
            // A request to another adult is always seen by both: the server writes it so. It is the family's, so
            // no group can hold it either.
            who.disable("personal", Boolean(assignee));
            groups.forEach((group) => who.disable("group:" + group.id, Boolean(assignee)));
            who.set(assignee ? "family" : whoChoice);
            whoNote.hidden = !assignee;
          },
          options: [["me", "Мне"], ...others.map((person) => [person.ref, person.name])],
          value: "me",
        });
        to.node.classList.add("segments-wrap");
        toBlock.append(toCaption, to.node);
      }

      const groupTo = groupPeople();

      const projects = board.sections.filter((section) => section.kind === "project" && section.project);
      const list = FA.card("fields");
      let select = null;
      if (projects.length > 0) {
        const row = el("label", "field-row select-row");
        select = el("select", "field-select");
        select.append(new Option("Без проекта", ""));
        projects.forEach((section) => select.append(new Option(section.title, section.project.id)));
        row.append(FA.icon("folder", "field-icon"), el("span", "field-label", "Проект"), select);
        list.append(row);
      }
      const voice = button("link-button hint-line", "", () => FA.dictate({ kind: "task" }));
      voice.append(FA.icon("mic"), el("span", null, "Надиктовать списком"));
      const errors = el("div");
      const added = el("div", "added-line");
      added.setAttribute("role", "status");
      form.append(titleBlock, dueBlock);
      if (others.length > 0) form.append(toBlock);
      form.append(groupTo.node, whoBlock);
      if (select) form.append(list);
      form.append(voice);
      view.append(form, added, errors, button("secondary-button wide", "Готово", () => FA.back()));

      const ready = () => title.value.trim().length > 0;
      // The same fields are the same task: a retry or a second «Добавить» after a lost answer resends the
      // same nonce, so the task is not created twice. Any change, or a task already added, makes a new one.
      let last = null;

      function showAdded(item) {
        const text = item.to ? "Отправлено · " + item.to + ": " + item.title + " — ждёт ответа" : "Добавлено: " + item.title;
        added.replaceChildren(FA.icon("check-circle", "added-icon"), el("span", "added-text", text),
          button("link-button", "Открыть", () => FA.go("#task/" + encodeURIComponent(item.id))));
      }

      /** Ready for the next one: the title goes, the day, project and people stay. */
      function nextOne() {
        last = null;
        title.value = "";
        FA.lockForm(form, false);
        ctx.main.update({ disabled: true });
        if (ctx.live()) title.focus();
      }

      // Visibility travels in the create itself, so there is no second step to fail. A project of the other
      // kind (a personal task in a family project) is refused by the server with its own words, shown here.
      async function send(body, nonce) {
        await ctx.main.run(async () => {
          errors.replaceChildren();
          FA.lockForm(form, true);
          let task;
          const group = groupOf(whoChoice);
          try {
            ({ task } = group
              ? await FA.writeToGroup(group.id, body, nonce)
              : await FA.post("/app-api/tasks", body, nonce));
          } catch (error) {
            FA.lockForm(form, false);
            // A refusal (4xx: a project of the other kind, a bad field) is not fixed by sending it again.
            const retry = error.status >= 400 && error.status < 500 ? null : () => send(body, nonce);
            if (ctx.live()) FA.failed(error, errors, retry);
            return;
          }
          FA.board.invalidate();
          FA.haptic("success");
          added.replaceChildren();
          nextOne();
          if (group) {
            const to = groupTo.person();
            added.replaceChildren(FA.icon("check-circle", "added-icon"), el("span", "added-text", to
              ? "Отправлено в «" + group.title + "» · " + to.name + ": " + body.title + " — ждёт ответа"
              : "Добавлено в группу «" + group.title + "»: " + body.title),
              button("link-button", "Открыть", () => FA.go("#group/" + encodeURIComponent(group.id))));
          } else {
            showAdded({ id: task.id, title: body.title, to: assignee ? assignee.name : null });
          }
        });
      }

      function submit() {
        if (!ready() || ctx.main.busy) return;
        const body = { title: title.value.trim() };
        if (groupOf(whoChoice)) {
          if (dueOn) body.dueOn = dueOn;
          Object.assign(body, groupTo.body());
          const key = JSON.stringify({ group: whoChoice, ...body });
          if (!last || last.key !== key) last = { key, nonce: FA.nonce() };
          send(body, last.nonce);
          return;
        }
        if (dueOn) body.dueOn = dueOn;
        if (select && select.value) body.projectRef = select.value;
        if (assignee) body.assigneeRef = assignee.ref;
        // A request to another adult is always seen by both: the server decides, nothing to send.
        else if (whoTouched) body.visibility = who.value();
        const key = JSON.stringify(body);
        if (!last || last.key !== key) last = { key, nonce: FA.nonce() };
        send(body, last.nonce);
      }
      title.addEventListener("input", () => ctx.main.update({ disabled: !ready() }));
      title.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
      });
      applyWho();
      ctx.main.set({ disabled: !ready(), onClick: submit, text: "Добавить" });
      // A typed title not yet added is not dropped on the way out: «Готово», «Назад» and a tab ask first.
      ctx.guard = async () => {
        if (!ready()) return true;
        const answer = await FA.ask({
          buttons: [{ id: "drop", kind: "destructive", text: "Не добавлять" }, { id: "stay", text: "Остаться" }],
          message: title.value.trim(),
          title: "Дело ещё не добавлено",
        });
        return answer === "drop";
      };
      title.focus();
      return () => { ctx.guard = null; };
    },
  });
})();
