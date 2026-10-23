// «Покупки»: the family's shopping lists. Changes go to the server one at a time, in the order they were
// made: a tick shows its new state at once as «pending», with that row's controls locked, and the next
// change waits in a queue. What the page draws is always the server's last list plus the pending marks;
// a version is read from that list when a change is sent, never from the moment of the tap.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;
  const DEFAULT_LIST = "Продукты";

  FA.screen("shopping", {
    parent: "#more",
    parentLabel: "Ещё",
    tab: "more",
    title: "Покупки",
    async render(view, _arg, ctx) {
      FA.header(view, { shusha: "shusha-basket", subtitle: "Общий список семьи", title: "Покупки" });
      const [first, caps] = await FA.load(view, () => Promise.all([FA.get("/app-api/shopping"), FA.capabilities()]));
      let items = first.items;
      // Item id → the change waiting or in flight for it; survives every redraw.
      const pending = new Map();
      const queue = [];
      let running = false;
      // The add field: its text and whether its item is on the way, kept across redraws.
      const draft = { busy: false, text: "" };
      // A redraw replaces the rows; the control that was pressed keeps the focus.
      let focusId = null;
      const body = el("div");
      const errors = el("div");
      view.append(errors, body);

      /** A job keeps its nonce: «Повторить» puts the same job back, so a lost answer is not a second change. */
      function enqueue(job) {
        if (job.id) pending.set(job.id, job.verb);
        else draft.busy = true;
        queue.push(job);
        draw();
        pump();
      }

      async function pump() {
        if (running) return;
        running = true;
        while (queue.length > 0) {
          const job = queue.shift();
          try {
            if (job.id) {
              const current = items.find((item) => item.id === job.id);
              if (current) {
                const path = "/app-api/shopping/" + encodeURIComponent(job.id) + "/" + job.verb;
                items = (await FA.post(path, { version: current.version }, job.nonce)).items;
                FA.haptic(job.verb === "remove" ? "success" : "select");
              }
              pending.delete(job.id);
            } else {
              items = (await FA.post("/app-api/shopping", { title: job.title }, job.nonce)).items;
              draft.busy = false;
              draft.text = "";
              focusId = "add";
              FA.haptic("success");
            }
          } catch (error) {
            if (job.id) pending.delete(job.id); else draft.busy = false;
            if (error.status === 409) {
              // Someone changed the list: read it again and go on with the rest of the queue.
              try {
                items = (await FA.get("/app-api/shopping")).items;
              } catch (_) { /* the next change will say so */ }
              FA.toast("Список уже изменили. Обновил его.");
            } else {
              errors.replaceChildren();
              FA.failed(error, errors, () => {
                errors.replaceChildren();
                enqueue(job);
              });
            }
          }
          draw();
        }
        running = false;
      }

      function shown(item) {
        const verb = pending.get(item.id);
        if (verb === "buy") return { ...item, bought: true };
        if (verb === "unbuy") return { ...item, bought: false };
        return item;
      }

      function row(item) {
        const waiting = pending.has(item.id);
        const li = el("li", "shop-row" + (item.bought ? " is-bought" : "") + (waiting ? " is-pending" : ""));
        const name = item.quantity ? item.title + " · " + item.quantity : item.title;
        // Pending controls stay focusable (aria-disabled, not disabled) so the focus survives the redraw.
        const check = button("shop-check", "", () => {
          if (pending.has(item.id)) return;
          focusId = item.id;
          errors.replaceChildren();
          enqueue({ id: item.id, nonce: FA.nonce(), verb: item.bought ? "unbuy" : "buy" });
        });
        check.dataset.id = item.id;
        if (waiting) check.setAttribute("aria-disabled", "true");
        check.setAttribute("role", "checkbox");
        check.setAttribute("aria-checked", String(item.bought));
        check.setAttribute("aria-label", "Куплено: " + name);
        check.append(FA.icon("check", "check-mark"));
        const text = el("div", "shop-text");
        text.append(FA.bdi(name, "shop-title"));
        if (waiting) text.append(el("span", "task-meta", pending.get(item.id) === "remove" ? "Убираю…" : "Сохраняю…"));
        else if (item.addedBy) text.append(el("span", "task-meta", item.addedBy));
        li.append(check, text);
        const remove = button("icon-button shop-remove", "", async () => {
          if (pending.has(item.id) || !(await FA.confirm("Убрать из списка?", "Убрать", name))) return;
          errors.replaceChildren();
          enqueue({ id: item.id, nonce: FA.nonce(), verb: "remove" });
        });
        if (waiting) remove.setAttribute("aria-disabled", "true");
        remove.setAttribute("aria-label", "Убрать из списка: " + name);
        remove.append(FA.icon(item.bought ? "trash" : "close"));
        li.append(remove);
        return li;
      }

      let addJob = null;
      function addForm(listName) {
        const form = el("div", "shop-add" + (draft.busy ? " is-busy" : ""));
        const input = el("input", "shop-input");
        input.type = "text";
        input.placeholder = "Добавить…";
        input.maxLength = 200;
        input.enterKeyHint = "done";
        input.value = draft.text;
        input.readOnly = draft.busy;
        if (draft.busy) input.setAttribute("aria-busy", "true");
        input.dataset.id = "add";
        input.setAttribute("aria-label", "Добавить в список «" + listName + "»");
        input.addEventListener("input", () => { draft.text = input.value; });
        input.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" || draft.busy) return;
          event.preventDefault();
          const title = input.value.trim();
          if (!title) return;
          errors.replaceChildren();
          focusId = "add";
          // The same text after a failed attempt is the same item: it keeps its nonce.
          if (!addJob || addJob.title !== title) addJob = { nonce: FA.nonce(), title };
          enqueue(addJob);
        });
        form.append(FA.icon("plus", "shop-add-icon"), input);
        return form;
      }

      function draw() {
        const all = items.map(shown);
        const open = all.filter((item) => !item.bought);
        const bought = all.filter((item) => item.bought);
        const lists = new Map();
        open.forEach((item) => {
          if (!lists.has(item.listName)) lists.set(item.listName, []);
          lists.get(item.listName).push(item);
        });
        // New items go to «Продукты» (the server's rule), so that list always has the add field.
        if (!lists.has(DEFAULT_LIST)) lists.set(DEFAULT_LIST, []);
        body.replaceChildren();
        lists.forEach((group, listName) => {
          const card = FA.card("shop-card");
          card.append(FA.bdi(listName, "card-title"));
          const list = el("ul", "shop-list");
          group.forEach((item) => list.append(row(item)));
          card.append(list);
          if (group.length === 0 && listName === DEFAULT_LIST) card.append(el("p", "card-sub", "Пусто. Добавьте первую покупку здесь или сообщением боту."));
          if (listName === DEFAULT_LIST) card.append(addForm(listName));
          body.append(card);
        });
        if (bought.length > 0) {
          const card = FA.card("fold");
          const toggle = button("fold-toggle");
          toggle.append(el("span", "fold-text", "Куплено · " + bought.length), FA.icon("chevron-right", "fold-chevron"));
          const list = el("ul", "shop-list");
          list.id = "shop-bought";
          bought.forEach((item) => list.append(row(item)));
          toggle.setAttribute("aria-controls", list.id);
          const paint = (isOpen) => {
            toggle.setAttribute("aria-expanded", String(isOpen));
            list.hidden = !isOpen;
          };
          paint(FA.uiGet("fold.bought", false));
          toggle.addEventListener("click", () => {
            const isOpen = list.hidden;
            paint(isOpen);
            FA.uiSet("fold.bought", isOpen);
          });
          card.append(toggle, list);
          body.append(card);
        }
        const focused = focusId && body.querySelector('[data-id="' + CSS.escape(focusId) + '"]');
        if (focused && view.isConnected) focused.focus();
        ctx.main.set(caps.grocery && open.length > 0 ? { onClick: cart, text: "Собрать корзину ВкусВилла" } : null);
      }

      // One hint request per visit: «Повторить» or a second tap resends the same nonce.
      const cartNonce = FA.nonce();
      function cart() {
        return ctx.main.run(async () => {
          errors.replaceChildren();
          try {
            await FA.hint("grocery-cart", cartNonce);
          } catch (error) {
            if (ctx.live()) FA.failed(error, errors, cart);
          }
        });
      }
      draw();
    },
  });
})();
