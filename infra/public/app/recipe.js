// A Studio recipe (#recipe/<id>, docs/design/v10 recipe.jpg, card.jpg): what to make from what. The photo
// comes from the person's pictures or straight from the phone; the card adds an occasion and «Кому»; all of
// it becomes the run's note. «Сделать» runs it at the server (studio-run.js); «Оживить фото» (video) is still
// a hint into the chat. Each finished run of this visit stays as a version to compare.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;
  const NOTE_MAX = 300;

  /** «Ваши фото» as a choice: «С телефона» first, «Без фото» when the photo is optional, then the pictures. */
  function photoPicker(options) {
    const { images, loader, optional } = options;
    const block = el("div", "photo-picker");
    const stage = el("div", "recipe-stage");
    const errors = el("div");
    const strip = el("div", "photo-strip");
    const radios = el("div", "photo-radios");
    radios.setAttribute("role", "radiogroup");
    radios.setAttribute("aria-label", "Какое фото");
    let chosen = optional || images.length === 0 ? null : images[0];

    function paint() {
      radios.querySelectorAll("[role=radio]").forEach((node) => node.setAttribute("aria-checked", String(node.file === chosen)));
      stage.replaceChildren(...(chosen ? [loader.thumb(chosen, "recipe-photo")] : []));
      stage.hidden = !chosen;
      options.onChange(chosen);
    }
    function pickTile(file) {
      const pick = button("photo-pick", "", () => {
        chosen = file;
        paint();
      });
      pick.file = file;
      pick.setAttribute("role", "radio");
      pick.setAttribute("aria-label", (file.caption || "Картинка") + ", " + FA.shortDate(file.at));
      pick.append(loader.thumb(file), FA.sourceBadge(file, "photo-badge"));
      return pick;
    }

    if (optional) {
      const none = button("photo-pick photo-none", "", () => {
        chosen = null;
        paint();
      });
      none.file = null;
      none.setAttribute("role", "radio");
      none.append(FA.icon("close"), el("span", null, "Без фото"));
      radios.append(none);
    }
    images.slice(0, 12).forEach((file) => radios.append(pickTile(file)));
    // A photo from the phone becomes the chosen source at once, shown from its local copy.
    const upload = FA.uploadButton({
      ariaLabel: "Загрузить фото с телефона",
      className: "photo-pick upload-tile",
      label: "С телефона",
      onUploaded(file, blob) {
        loader.seed(file, blob);
        const tile = pickTile(file);
        const first = radios.querySelector(".photo-pick:not(.photo-none)");
        radios.insertBefore(tile, first);
        chosen = file;
        paint();
        hint.hidden = true;
      },
      place: errors,
    });
    strip.append(upload, radios);
    const hint = el("p", "card-sub studio-quiet", "Загрузите фото с телефона или пришлите его в чат — оно появится здесь.");
    hint.hidden = images.length > 0 || optional;
    block.append(stage, FA.sectionTitle(optional ? "Фото (можно без)" : "Ваши фото"), strip, hint, errors);
    paint();
    return { node: block, value: () => chosen };
  }

  FA.screen("recipe", {
    parent: "#create",
    parentLabel: "Создать",
    tab: "create",
    title: "Создать",
    async render(view, id, ctx) {
      const { images, recipes } = await FA.loadStudio(view);
      const recipe = recipes.find((item) => item.id === id);
      if (!recipe) {
        FA.header(view, { title: "Создать" });
        view.append(FA.empty("Такого рецепта нет.", "Возможно, он недоступен на этом сервере.", "think"));
        return undefined;
      }
      FA.header(view, { subtitle: recipe.lead, title: recipe.title });
      const loader = FA.previewLoader();
      const form = el("div", "recipe-form");
      const runPlace = el("div", "recipe-run");
      // The video recipe has no endpoint yet: it stays a hint into the chat.
      const viaChat = recipe.id === "animate";
      const versions = [];
      let chosen = null;

      if (recipe.photo !== "none") {
        const picker = photoPicker({ images, loader, onChange: (file) => { chosen = file; }, optional: recipe.photo === "optional" });
        form.append(picker.node);
        chosen = picker.value();
      }

      // The card (card.jpg): what for and for whom; both go into the note.
      let occasion = null;
      let whom = null;
      if (recipe.occasions) {
        const occasionTitle = FA.sectionTitle("Повод");
        occasionTitle.id = "recipe-occasion";
        occasion = FA.radioGroup({ labelledBy: occasionTitle.id, options: recipe.occasions.map((label) => [label, label]), value: recipe.occasions[0] });
        occasion.node.classList.add("segments-wrap", "recipe-variants");
        const whomLabel = el("label", "section-title recipe-detail-label", "Кому");
        whom = el("input", "text-input");
        whom.id = "recipe-whom";
        whom.maxLength = 80;
        whom.placeholder = "Например: бабушке Ирине";
        whomLabel.htmlFor = whom.id;
        form.append(occasionTitle, occasion.node, whomLabel, whom);
      }

      const askTitle = FA.sectionTitle(recipe.ask);
      askTitle.id = "recipe-ask";
      const variants = FA.radioGroup({ labelledBy: askTitle.id, options: recipe.variants.map((label) => [label, label]), value: recipe.variants[0] });
      variants.node.classList.add("segments-wrap", "recipe-variants");
      // «Картинка по описанию» has nothing to start from but the words, so they are required there.
      const words = recipe.id === "image";
      const detailLabel = el("label", "section-title recipe-detail-label", words ? "Что нарисовать?" : "Добавьте детали");
      const detail = el("input", "text-input");
      detail.id = "recipe-detail";
      detail.maxLength = 200;
      detail.placeholder = words ? "Например: уютный осенний дом" : "Например: мягкий свет, подушки";
      detailLabel.htmlFor = detail.id;
      const say = el("div", "recipe-say");
      say.append(FA.art("shusha-painter", "recipe-say-art"), el("p", "recipe-say-text", recipe.line));
      const errors = el("div");
      form.append(askTitle, variants.node, detailLabel, detail, say, errors, el("p", "footnote", viaChat
        ? "Видео " + FA.agent() + " делает в чате: «Сделать видео» пришлёт туда пример — отправьте его с вашим фото."
        : "Готовая картинка появится здесь и придёт в чат."));
      view.append(form, runPlace);

      let stopRun = () => {};
      const ready = { onClick: make, text: recipe.main || "Сделать" };
      function edit() {
        stopRun();
        runPlace.replaceChildren();
        form.hidden = false;
        ctx.main.set(ready);
      }
      const hintNonce = FA.nonce();
      function make() {
        errors.replaceChildren();
        if (viaChat) {
          FA.askInChat("studio-" + recipe.id, (work) => ctx.main.run(work), errors, hintNonce);
          return;
        }
        if (words && !detail.value.trim()) {
          errors.append(FA.errorBox(new Error("Опишите, что нарисовать: например, «уютный осенний дом».")));
          detail.focus();
          return;
        }
        if (recipe.photo === "required" && !chosen) {
          errors.append(FA.errorBox(new Error("Сначала нужно фото: загрузите его с телефона или пришлите в чат.")));
          return;
        }
        const parts = [occasion && occasion.value(), whom && whom.value.trim() ? "кому: " + whom.value.trim() : null, variants.value(), detail.value.trim()];
        const note = Array.from(parts.filter(Boolean).join(", ")).slice(0, NOTE_MAX).join("");
        const payload = { note, recipe: recipe.id };
        if (chosen) payload.source = { path: chosen.path, scope: chosen.scope };
        form.hidden = true;
        // Before/after only where the picture keeps the photo's frame: not for stories (9:16) or a card.
        const compare = Boolean(chosen) && recipe.id !== "story" && recipe.id !== "card";
        stopRun = FA.studioRun({ compare, ctx, loader, onEdit: edit, payload, place: runPlace, source: chosen, versions });
      }
      ctx.main.set(ready);
      return () => {
        stopRun();
        loader.revoke();
      };
    },
  });
})();
