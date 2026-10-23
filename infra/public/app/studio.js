// «Создать» (#create): Шуша's studio (docs/design/v10). The person's pictures, recipes («Улучшить фото»,
// «Золотой час», «Открытка к поводу»…) and, below, everything else the bot can do. A recipe (#recipe/<id>)
// gathers what to make: the photo, a variant, a detail, and «Сделать» runs it at the server (studio-run.js);
// the picture comes back here and into the chat. «Оживить фото» (video) still goes through the chat: its
// «Сделать видео» sends the example there (hint `studio-animate`).
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;

  // `photo`: "required", "optional" or "none" (as the server's recipe rules); `needs`: a capability flag;
  // `occasions`: the card's «Повод» chips.
  const RECIPES = [
    { ask: "Что улучшить?", icon: "wand", id: "enhance", lead: "Свет, цвет и чёткость", line: "Сделаю как в хороший день.", needs: "images", photo: "required", title: "Улучшить фото", variants: ["Всё сразу", "Свет", "Цвет", "Чёткость"] },
    { ask: "Какой формат?", icon: "phone", id: "story", lead: "Вертикально, 9:16", line: "Чтобы смотрелось на весь экран.", needs: "images", photo: "required", title: "Для сторис", variants: ["Просто 9:16", "С рамкой", "С подписью"] },
    { ask: "Какой свет?", icon: "sun", id: "golden", lead: "Тёплый вечерний свет", line: "Немного солнца никогда не лишнее.", needs: "images", photo: "required", title: "Золотой час", variants: ["Тёплый вечер", "Мягкое утро", "Закат"] },
    { ask: "Какой фон?", icon: "image", id: "background", lead: "Парк, море или студия", line: "Перенесу вас куда захотите.", needs: "images", photo: "required", title: "Сменить фон", variants: ["Осенний парк", "Море", "Студия", "Дом"] },
    { ask: "Как раскрасить?", icon: "palette", id: "colorize", lead: "Старое фото в цвете", line: "Аккуратно, как было на самом деле.", needs: "images", photo: "required", title: "Раскрасить старое", variants: ["Естественно", "Чуть ярче", "Сохранить сепию"] },
    { ask: "Что примерим?", icon: "sofa", id: "interior", lead: "Мебель в вашей комнате", line: "Посмотрим, как будет дома.", needs: "images", photo: "required", title: "Примерить в интерьере", variants: ["Серый диван", "Зелёный бархат", "Без дивана"] },
    { ask: "Стиль открытки", icon: "heart", id: "card", lead: "Поздравление, можно с вашим фото", line: "Порадуем того, кто ждёт.", main: "Сделать открытку", needs: "images", occasions: ["День рождения", "Праздник", "Спасибо", "Просто так"], photo: "optional", title: "Открытка к поводу", variants: ["Акварель", "Ретро-фото", "Детский рисунок"] },
    { ask: "Движение", icon: "film", id: "animate", lead: "Короткое видео из снимка", line: "Пусть момент оживёт.", main: "Сделать видео", needs: "video", photo: "required", title: "Оживить фото", variants: ["Камера наезжает", "Пролёт дрона", "Ветер в листьях"] },
    { ask: "В каком стиле?", icon: "sparkle", id: "image", lead: "Что угодно по вашим словам", line: "Расскажите — нарисую.", needs: "images", photo: "none", title: "Картинка по описанию", variants: ["Акварель", "Мультфильм", "Как фото"] },
  ];

  FA.STUDIO_RECIPES = RECIPES;

  /** The person's pictures (Шуша's and photos from the phone) and the recipes this server can run. */
  FA.loadStudio = async function loadStudio(view) {
    const [files, caps] = await FA.load(view, () => Promise.all([FA.get("/app-api/files").catch(() => ({ files: [] })), FA.capabilities()]));
    return { caps, images: files.files.filter((file) => file.kind === "image"), recipes: RECIPES.filter((recipe) => !recipe.needs || caps[recipe.needs]) };
  };

  FA.screen("create", {
    parent: null,
    tab: "create",
    title: "Создать",
    async render(view) {
      const { caps, images, recipes } = await FA.loadStudio(view);
      FA.hero(view, { caption: "Студия " + FA.agent("genitive"), lines: ["Что сделаем", "красивым", "сегодня?"], scene: "scene-morning", shusha: "shusha-painter" });
      const loader = FA.previewLoader();

      // Ваши фото: the pictures already made or sent; a tap opens the gallery's sheet.
      const photos = el("section", "board-block");
      const photosHead = el("div", "block-head");
      photosHead.append(FA.sectionTitle("Ваши фото"));
      const errors = el("div");
      const strip = el("div", "photo-strip");
      const quiet = el("p", "card-sub studio-quiet", "Здесь появятся ваши фото и картинки " + FA.agent("genitive") + ". Загрузите фото с телефона — и выберите рецепт.");
      const tile = (file) => {
        const pick = button("photo-pick", "", () => FA.fileSheet(file, loader, caps));
        pick.setAttribute("aria-label", (file.caption || "Картинка") + ", " + FA.shortDate(file.at));
        pick.append(loader.thumb(file), FA.sourceBadge(file, "photo-badge"));
        return pick;
      };
      images.slice(0, 12).forEach((file) => strip.append(tile(file)));
      // «Загрузить»: the photo joins the strip at once, from its local copy.
      photosHead.append(FA.uploadButton({
        label: "Загрузить",
        onUploaded(file, blob) {
          loader.seed(file, blob);
          strip.prepend(tile(file));
          strip.hidden = false;
          quiet.hidden = true;
          FA.toast("Фото загружено");
        },
        place: errors,
      }));
      strip.hidden = images.length === 0;
      quiet.hidden = images.length > 0;
      photos.append(photosHead, errors, strip, quiet);
      view.append(photos);

      if (recipes.length > 0) {
        view.append(FA.sectionTitle("Что создадим?"));
        const grid = el("div", "recipe-grid");
        recipes.forEach((recipe) => {
          const card = button("recipe-card", "", () => FA.go("#recipe/" + recipe.id));
          const art = el("span", "recipe-art art-" + recipe.id);
          art.append(FA.icon(recipe.icon, "recipe-icon"));
          const text = el("span", "recipe-text");
          text.append(el("span", "recipe-title", recipe.title), el("span", "recipe-lead", recipe.lead));
          card.append(art, text);
          grid.append(card);
        });
        view.append(grid);
      }

      // Ещё я умею: the rest of the catalog as quiet chip rows, each to its own card.
      const covered = new Set(["image", "photo-edit", "animate"]);
      const skills = FA.SKILLS.filter((skill) => (!skill.needs || caps[skill.needs]) && !covered.has(skill.id));
      const more = el("section", "board-block more-skills");
      more.append(FA.sectionTitle("Ещё я умею"));
      FA.SKILL_GROUPS.forEach((group) => {
        const items = skills.filter((skill) => skill.group === group);
        if (items.length === 0) return;
        more.append(el("p", "skill-group-name", group));
        const row = el("div", "chips chips-scroll skill-chips");
        items.forEach((skill) => {
          const chip = button("chip skill-chip", "", () => FA.go("#skill/" + skill.id));
          chip.append(FA.icon(skill.icon), el("span", null, skill.title));
          row.append(chip);
        });
        more.append(row);
      });
      view.append(more);
      return () => loader.revoke();
    },
  });

  // The old catalog address leads to the studio.
  FA.screen("skills", {
    parent: null,
    tab: "create",
    title: "Создать",
    render() {
      location.replace("#create");
    },
  });
})();
