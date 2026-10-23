// «Ещё»: the hub of personal settings and lists, the data commands, and «Подключения».
// Data commands are not run from the page: the bot sends the command into the private chat and the person
// sends it, so export and deletion keep their own confirmations in the chat.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;
  // The privacy page lives next to the Mini App on the same host (`infra/public/privacy.html`).
  const PRIVACY = new URL("/privacy", location.origin).toString();

  const COMMANDS = {
    "cmd-delete-me": {
      text: "Бот пришлёт в чат команду /delete_me. Отправьте её — бот сначала объяснит, что удалится, и попросит подтвердить. Здесь ничего не удаляется.",
      title: "Удалить мои данные",
    },
    "cmd-export": { text: "Бот пришлёт в чат команду /export — отправьте её, и файл придёт следом.", title: "Выгрузить мои данные" },
    "cmd-feedback": { text: "Бот пришлёт в чат команду /feedback — отправьте её вместе с вашим текстом одним сообщением.", title: "Написать разработчику" },
    "connect-google": { text: "Бот пришлёт в чат фразу для подключения, а в ответ — защищённую ссылку на вход в Google.", title: "Подключить Google" },
    "memory-edit": { text: "Исправление идёт через чат: бот пришлёт подсказку, как написать, что изменить.", title: "Изменить сведение" },
  };

  /** Explain first, then ask the bot for the hint; the app closes so the chat is in front. */
  FA.hintSheet = function hintSheet(id) {
    const info = COMMANDS[id];
    const errors = el("div");
    // One request per opened sheet: a second tap after a lost answer resends the same nonce.
    const nonce = FA.nonce();
    const send = () => sheet.main.run(async () => {
      errors.replaceChildren();
      try {
        await FA.hint(id, nonce);
        sheet.close();
      } catch (error) {
        FA.failed(error, errors, send);
      }
    });
    const sheet = FA.openSheet({
      build(body) {
        body.append(el("p", "sheet-text", info.text), errors);
      },
      main: { onClick: () => send(), text: "Прислать в чат" },
      title: info.title,
    });
  };

  function summary(settings) {
    const overview = settings.overview.enabled ? "в " + settings.overview.hour + ":00" : "выключена";
    const quiet = settings.quietStart && settings.quietEnd
      ? settings.quietStart.replace(/^0/u, "") + "–" + settings.quietEnd.replace(/^0/u, "")
      : "не заданы";
    return { overview, quiet };
  }

  FA.screen("more", {
    parent: null,
    tab: "more",
    title: "Ещё",
    async render(view) {
      FA.header(view, { title: "Ещё" });
      // Subtitles are a courtesy: a failed read leaves the row without one, not the screen without rows.
      const [settings, routines, shopping, caps] = await FA.load(view, () => Promise.all([
        FA.get("/app-api/settings").catch(() => null),
        FA.get("/app-api/routines").catch(() => null),
        FA.get("/app-api/shopping").catch(() => null),
        FA.capabilities(),
      ]));
      const said = settings ? summary(settings) : null;
      const card = FA.card("nav-card");
      card.append(
        FA.navRow({ icon: "bell", onClick: () => FA.go("#settings"), subtitle: said && said.overview, title: "Утренняя сводка" }),
        FA.navRow({ icon: "moon", onClick: () => FA.go("#settings"), subtitle: said && said.quiet, title: "Тихие часы" }),
        FA.navRow({ icon: "person", onClick: () => FA.go("#memory"), subtitle: "Личные сведения", title: "Что бот обо мне помнит" }),
      );
      const routineCount = routines ? routines.schedules.length + routines.reminders.length : null;
      card.append(FA.navRow({
        icon: "calendar",
        onClick: () => FA.go("#routines"),
        subtitle: routineCount === null ? null : routineCount === 0 ? "Пока нет" : FA.count(routineCount, ["запись", "записи", "записей"]),
        title: "Напоминания и регулярное",
      }));
      const toBuy = shopping ? shopping.items.filter((item) => !item.bought).length : null;
      card.append(FA.navRow({
        icon: "cart",
        onClick: () => FA.go("#shopping"),
        subtitle: toBuy === null ? null : toBuy === 0 ? "Список пуст" : toBuy + " в списке",
        title: "Покупки",
      }));
      card.append(FA.navRow({ icon: "image", onClick: () => FA.go("#media"), title: "Мои картинки и файлы" }));
      const available = [caps.google && "Google", caps.grocery && "ВкусВилл", (caps.images || caps.video) && "картинки"].filter(Boolean);
      card.append(FA.navRow({
        icon: "link",
        onClick: () => FA.go("#connections"),
        subtitle: available.length > 0 ? available.join(", ") : "Пока ничего",
        title: "Подключения",
      }));
      view.append(card);

      // v3: the app as a screen of its own, where the Telegram client can (Mini Apps 8.0): shown only when supported.
      const tg = FA.tg;
      const can = (version) => Boolean(tg && typeof tg.isVersionAtLeast === "function" && tg.isVersionAtLeast(version));
      const screenRows = [];
      if (can("8.0") && typeof tg.requestFullscreen === "function" && !tg.isFullscreen) {
        screenRows.push(FA.navRow({ icon: "window", onClick: () => { try { tg.requestFullscreen(); } catch (_) { /* refused */ } }, title: "Во весь экран" }));
      }
      if (can("8.0") && typeof tg.addToHomeScreen === "function") {
        screenRows.push(FA.navRow({ icon: "phone", onClick: () => { try { tg.addToHomeScreen(); } catch (_) { /* refused */ } }, subtitle: "Открывать дела с рабочего стола", title: "Ярлык на экран" }));
      }
      if (screenRows.length > 0) {
        const screen = FA.card("nav-card");
        screen.append(...screenRows);
        view.append(screen);
      }

      view.append(FA.sectionTitle("Данные"));
      const data = FA.card("nav-card");
      data.append(
        FA.navRow({ icon: "download", onClick: () => FA.hintSheet("cmd-export"), title: "Выгрузить мои данные" }),
        FA.navRow({ icon: "chat", onClick: () => FA.hintSheet("cmd-feedback"), title: "Написать разработчику" }),
        FA.navRow({ external: true, icon: "shield", onClick: () => FA.openLink(PRIVACY), title: "Приватность" }),
      );
      view.append(data);
      const danger = FA.card("nav-card");
      danger.append(FA.navRow({ danger: true, icon: "trash", onClick: () => FA.hintSheet("cmd-delete-me"), title: "Удалить мои данные" }));
      view.append(danger);
    },
  });

  function connection(options) {
    const card = FA.card("connection");
    card.append(FA.icon(options.icon, "connection-icon"));
    const text = el("div", "connection-text");
    text.append(el("h2", "connection-title", options.title));
    if (options.sub) text.append(el("p", "connection-sub", options.sub));
    const status = el("p", "connection-status" + (options.on ? " is-on" : ""));
    status.append(FA.icon(options.on ? "check-circle" : "minus-circle"), el("span", null, options.status));
    text.append(status);
    if (options.action) text.append(options.action);
    card.append(text);
    return card;
  }

  FA.screen("connections", {
    parent: "#more",
    parentLabel: "Ещё",
    tab: "more",
    title: "Подключения",
    async render(view) {
      FA.header(view, { title: "Подключения" });
      const caps = await FA.load(view, () => FA.capabilities());
      const connect = caps.google ? button("link-button", "Подключить в чате", () => FA.hintSheet("connect-google")) : null;
      const media = caps.images && caps.video ? "Доступно" : caps.images ? "Картинки доступны, видео нет"
        : caps.video ? "Видео доступно, картинки нет" : "Недоступно на этом сервере";
      view.append(
        connection({
          action: connect,
          icon: "globe",
          on: caps.google,
          status: caps.google ? "Доступно, подключается в чате" : "Недоступно на этом сервере",
          sub: "Календарь, Почта, Диск",
          title: "Google",
        }),
        connection({ icon: "basket", on: caps.grocery, status: caps.grocery ? "Доступно" : "Недоступно на этом сервере", title: "ВкусВилл" }),
        connection({ icon: "image", on: caps.images || caps.video, status: media, title: "Картинки и видео" }),
        el("p", "footnote", "Подключение и отключение — через чат, бот пришлёт защищённую ссылку."),
      );
    },
  });
})();
