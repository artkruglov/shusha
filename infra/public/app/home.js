// «Сегодня» (the board's root): the greeting hero and «Шуша сделала за вас». The greeting and the name come
// from /app-api/home (the person's hour); the sentence under it is built here from the board: how many
// tasks today and how long the oldest overdue one waits. Nothing is said about parts that are zero.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;

  const SMALL = { 1: "одно", 2: "два", 3: "три", 4: "четыре", 5: "пять", 6: "шесть", 7: "семь", 8: "восемь", 9: "девять" };
  // «с понедельника», «со вторника»…: the genitive after «с», 0 is Sunday.
  const SINCE = ["с воскресенья", "с понедельника", "со вторника", "со среды", "с четверга", "с пятницы", "с субботы"];

  const words = (n) => SMALL[n] || String(n);
  const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

  /** «с понедельника» within the last week, «с 9 октября» before that. */
  function sinceText(day, today) {
    const late = Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(day + "T00:00:00Z")) / 86400000);
    if (late <= 0) return null;
    if (late === 1) return "со вчерашнего дня";
    if (late < 7) return SINCE[new Date(day + "T00:00:00Z").getUTCDay()];
    return "с " + FA.dayMonth(day);
  }

  /** «Сегодня четыре дела, одно ждёт с понедельника.» — or «Сегодня свободно.» */
  FA.daySentence = function daySentence(board) {
    const of = (kind) => board.sections.filter((section) => section.kind === kind).reduce((n, section) => n + section.rows.length, 0);
    const today = of("today");
    const overdue = board.sections.filter((section) => section.kind === "overdue").flatMap((section) => section.rows);
    const oldest = overdue.map((row) => FA.overdueDay(row.detail, board.today)).filter(Boolean).sort()[0];
    const since = oldest ? sinceText(oldest, board.today) : null;
    const late = overdue.length === 0 ? null
      : (overdue.length === 1 ? "одно ждёт" : words(overdue.length) + " ждут") + (since ? " " + since : "");
    if (today === 0 && !late) return "Сегодня свободно.";
    if (today === 0) return capital(late) + ".";
    return "Сегодня " + words(today) + " " + FA.plural(today, FA.TASKS) + (late ? ", " + late : "") + ".";
  };

  const LOOK = {
    day: ["scene-morning", "shusha-wave"],
    evening: ["scene-evening", "shusha-list"],
    morning: ["scene-morning", "shusha-wave"],
    night: ["scene-evening", "shusha-sleep"],
  };
  const HOUR_GREETING = (hour) => (hour >= 5 && hour < 12 ? ["Доброе утро", "morning"] : hour < 18 && hour >= 12 ? ["Добрый день", "day"]
    : hour >= 18 && hour < 23 ? ["Добрый вечер", "evening"] : ["Доброй ночи", "night"]);

  /** The hero of «Сегодня»: scene and Шуша by the part of day; `sub` is the line under the greeting. */
  FA.homeHero = function homeHero(view, board, home, sub) {
    const [localGreeting, localPart] = HOUR_GREETING(new Date().getHours());
    const part = home ? home.partOfDay : localPart;
    // The part of day picks the scene and the pose in both themes; the dark theme only dims a daylight scene.
    const [scene, shusha] = LOOK[part] || LOOK.day;
    const greeting = home ? home.greeting : localGreeting;
    const lines = home && home.name ? [greeting + ",", home.name + "."] : [greeting + "."];
    return FA.hero(view, {
      // An empty board says it in its own words below; the hero does not repeat it.
      caption: FA.longDate(board.today), compact: true, light: scene === "scene-evening", lines, scene, shusha,
      sub: sub !== undefined ? sub : board.sections.length === 0 ? null : FA.daySentence(board),
    });
  };

  /** «Шуша сделала за вас»: up to four latest pictures; a tap opens the same sheet as the gallery. */
  FA.recentTiles = function recentTiles(view, recent, loader) {
    const items = (recent || []).slice(0, 4);
    if (items.length === 0) return;
    const block = el("section", "board-block recent-made");
    const head = el("div", "block-head");
    head.append(FA.sectionTitle(FA.Agent() + " сделала за вас"));
    const all = button("link-button step-link", "", () => FA.go("#media"));
    all.append(el("span", null, "Всё"), FA.icon("chevron-right", "step-chevron"));
    head.append(all);
    const grid = el("ul", "made-grid");
    items.forEach((file) => {
      const item = el("li");
      const tile = button("made-tile", "", async () => FA.fileSheet(file, loader, await FA.capabilities()));
      const title = file.caption || "Картинка";
      tile.setAttribute("aria-label", title + ", " + FA.shortDate(file.at));
      const text = el("span", "made-text");
      text.append(FA.bdi(title, "made-title"), el("span", "made-date", FA.shortDate(file.at)));
      tile.append(loader.thumb(file, "made-thumb"), text);
      item.append(tile);
      grid.append(item);
    });
    block.append(head, grid);
    view.append(block);
  };
})();
