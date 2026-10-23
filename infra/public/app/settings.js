// «Утренняя сводка» and the person's other contact settings. Nothing changes until «Сохранить»; the button
// appears only after a change, and leaving with changes asks «Сохранить изменения?» (guide §6).
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el } = FA;
  const DEFAULT_QUIET = ["23:00", "08:00"];

  const hourText = (hour) => hour + ":00";

  const clockText = FA.clockText;

  /** A saved time off the half-hour grid (set in the chat) still shows as it is. */
  function withValue(select, value) {
    if (value && !Array.from(select.options).some((option) => option.value === value)) {
      select.append(new Option(clockText(value), value));
      Array.from(select.options).sort((a, b) => a.value.localeCompare(b.value)).forEach((option) => select.append(option));
    }
    select.value = value || "";
  }

  // Names people use for the zones a family is likely to live in; anything else is the IANA city.
  const ZONES = {
    "Asia/Almaty": "Алматы", "Asia/Dubai": "Дубай", "Asia/Irkutsk": "Иркутск", "Asia/Krasnoyarsk": "Красноярск",
    "Asia/Novosibirsk": "Новосибирск", "Asia/Omsk": "Омск", "Asia/Tbilisi": "Тбилиси", "Asia/Tashkent": "Ташкент",
    "Asia/Vladivostok": "Владивосток", "Asia/Yekaterinburg": "Екатеринбург", "Asia/Yerevan": "Ереван",
    "Europe/Berlin": "Берлин", "Europe/Istanbul": "Стамбул", "Europe/Kaliningrad": "Калининград", "Europe/Kyiv": "Киев",
    "Europe/London": "Лондон", "Europe/Minsk": "Минск", "Europe/Moscow": "Москва", "Europe/Paris": "Париж",
    "Europe/Samara": "Самара", "Europe/Volgograd": "Волгоград",
  };

  /** «Москва · UTC+3»: the offset from Intl now, so summer time is right without a table of rules. */
  function zoneText(zone) {
    const city = ZONES[zone] || zone.split("/").pop().replace(/_/gu, " ");
    try {
      const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
        .formatToParts(new Date()).find((item) => item.type === "timeZoneName");
      const offset = part ? part.value.replace(/^GMT/u, "UTC") : "";
      return offset ? city + " · " + (offset === "UTC" ? "UTC+0" : offset) : city;
    } catch (_) {
      return city;
    }
  }

  FA.screen("settings", {
    parent: "#more",
    parentLabel: "Ещё",
    tab: "more",
    title: "Утренняя сводка",
    async render(view, _arg, ctx) {
      FA.header(view, { title: "Утренняя сводка" });
      let saved = await FA.load(view, () => FA.get("/app-api/settings"));
      let draft = null;
      let coachTouched = false;
      const errors = el("div");

      function snapshot(source) {
        return {
          coach: Boolean(source.coach),
          enabled: source.overview.enabled,
          hour: source.overview.hour,
          initiative: source.initiative,
          visibility: source.defaultVisibility || null,
          quietEnd: source.quietEnd,
          quietStart: source.quietStart,
          weeklyReview: source.weeklyReview,
        };
      }
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const valid = () => draft.quietStart === null || (draft.quietStart !== draft.quietEnd && Boolean(draft.quietStart && draft.quietEnd));
      const dirty = () => !same(draft, snapshot(saved));

      // ---- Overview ----
      const overviewCard = FA.card("settings-card");
      const overview = FA.switchRow({ checked: saved.overview.enabled, label: "Получать сводку", onChange: (on) => change({ enabled: on }) });
      const timeRow = el("div", "setting-row");
      const timeText = el("div", "switch-text");
      const timeLabel = el("label", "switch-label", "Время");
      const timeSub = el("span", "switch-sub");
      const hour = el("select", "inline-select");
      hour.id = "overview-hour";
      timeLabel.htmlFor = hour.id;
      saved.hours.forEach((value) => hour.append(new Option(hourText(value), String(value))));
      hour.addEventListener("change", () => change({ hour: Number(hour.value) }));
      timeText.append(timeLabel, timeSub);
      timeRow.append(timeText, hour);
      overviewCard.append(overview.row, timeRow);

      // ---- Quiet hours ----
      const quietCard = FA.card("settings-card");
      const noQuiet = FA.switchRow({
        checked: saved.quietStart === null,
        label: "Без тихих часов",
        onChange(off) {
          const [start, end] = off ? [null, null] : [lastQuiet[0], lastQuiet[1]];
          change({ quietEnd: end, quietStart: start });
        },
        sub: "Бот может написать в любое время",
      });
      let lastQuiet = saved.quietStart ? [saved.quietStart, saved.quietEnd] : DEFAULT_QUIET.slice();
      const quietRow = el("div", "quiet-row");
      const timeField = (id, label, key) => {
        const box = el("div", "quiet-field");
        const caption = el("label", "field-caption", label);
        const input = FA.timeSelect();
        input.id = id;
        caption.htmlFor = id;
        input.addEventListener("change", () => {
          const value = input.value || null;
          const next = key === "quietStart" ? [value, draft.quietEnd] : [draft.quietStart, value];
          lastQuiet = next;
          change({ [key]: value });
        });
        box.append(caption, input);
        quietRow.append(box);
        return input;
      };
      const quietTitle = el("h2", "card-title", "Тихие часы");
      const quietStart = timeField("quiet-start", "С", "quietStart");
      const quietEnd = timeField("quiet-end", "До", "quietEnd");
      const quietError = el("p", "field-error");
      quietError.setAttribute("role", "alert");
      quietCard.append(quietTitle, el("p", "card-sub", "В это время бот не пишет первым"), quietRow, quietError, noQuiet.row);

      // ---- Other switches ----
      const otherCard = FA.card("settings-card");
      const weekly = FA.switchRow({ checked: saved.weeklyReview, label: "Недельный обзор по воскресеньям", onChange: (on) => change({ weeklyReview: on }) });
      const coach = FA.switchRow({
        checked: Boolean(saved.coach),
        label: "Вопросы коуча",
        onChange(on) {
          coachTouched = true;
          change({ coach: on });
        },
        sub: "По вашему согласию",
      });
      const initiative = FA.switchRow({ checked: saved.initiative, label: "Писать мне первым", onChange: (on) => change({ initiative: on }) });
      otherCard.append(weekly.row, coach.row, initiative.row);

      const form = el("div", "settings-form");
      // ---- Who sees new tasks ----
      const tasksCard = FA.card("settings-card");
      const tasksTitle = el("h2", "card-title", "Новые дела");
      tasksTitle.id = "visibility-title";
      const visibility = FA.radioGroup({
        labelledBy: tasksTitle.id,
        onChange: (value) => change({ visibility: value }),
        options: [["family", "Для семьи"], ["personal", "Только мне"]],
        value: saved.defaultVisibility || null,
      });
      visibility.node.classList.add("settings-segments");
      // Never chosen: the server writes new tasks as personal until the person picks.
      const visibilityHint = el("p", "card-sub", "Пока записываю только вам");
      tasksCard.append(tasksTitle, el("p", "card-sub", "Поручение другому взрослому всегда видят оба"), visibility.node, visibilityHint);

      form.append(overviewCard, quietCard, otherCard, tasksCard);
      view.append(form, errors);
      const zone = zoneText(saved.timezone);
      view.append(el("p", "footnote", "Часовой пояс: " + zone + "."));

      function paint() {
        overview.set(draft.enabled);
        hour.value = String(draft.hour);
        hour.disabled = !draft.enabled;
        timeRow.classList.toggle("is-disabled", !draft.enabled);
        timeSub.textContent = draft.enabled ? zone : "Сначала включите сводку";
        const off = draft.quietStart === null;
        noQuiet.set(off);
        quietRow.hidden = off;
        withValue(quietStart, draft.quietStart);
        withValue(quietEnd, draft.quietEnd);
        quietError.textContent = !off && !valid() ? "Начало и конец тихих часов должны различаться." : "";
        weekly.set(draft.weeklyReview);
        coach.set(draft.coach);
        initiative.set(draft.initiative);
        visibility.set(draft.visibility);
        visibilityHint.hidden = draft.visibility !== null;
        ctx.main.set(dirty() && valid() ? { onClick: save, text: "Сохранить" } : null);
      }

      function change(patch) {
        draft = { ...draft, ...patch };
        errors.replaceChildren();
        paint();
      }

      // The same set of values is one operation: «Повторить» or a second «Сохранить» after a lost answer
      // resends its nonce. Nothing on the screen can change while it is out, so the answer replaces the draft
      // without dropping an edit made in between.
      let last = null;
      async function save() {
        if (!valid()) return false;
        const body = {
          initiative: draft.initiative,
          overview: { enabled: draft.enabled, hour: draft.hour },
          quietEnd: draft.quietEnd,
          quietStart: draft.quietStart,
          weeklyReview: draft.weeklyReview,
        };
        // The coach is a consent: sent only when the person touched it here.
        if (coachTouched) body.coach = draft.coach;
        // The default for new tasks only when it changed: an unchosen default stays unchosen.
        if (draft.visibility !== null && draft.visibility !== (saved.defaultVisibility || null)) body.defaultVisibility = draft.visibility;
        const key = JSON.stringify(body);
        if (!last || last.key !== key) last = { key, nonce: FA.nonce() };
        const nonce = last.nonce;
        const result = await ctx.main.run(async () => {
          errors.replaceChildren();
          FA.lockForm(form, true);
          try {
            saved = await FA.post("/app-api/settings", body, nonce);
            coachTouched = false;
            last = null;
            draft = snapshot(saved);
            FA.haptic("success");
            FA.toast("Сохранено");
            return true;
          } catch (error) {
            FA.failed(error, errors, save);
            return false;
          } finally {
            FA.lockForm(form, false);
            paint();
          }
        });
        return result === true;
      }

      ctx.guard = async () => {
        if (!dirty()) return true;
        const answer = await FA.ask({
          buttons: [{ id: "save", text: "Сохранить" }, { id: "drop", kind: "destructive", text: "Не сохранять" }, { id: "stay", text: "Остаться" }],
          title: "Сохранить изменения?",
        });
        if (answer === "drop") return true;
        if (answer === "save") return save();
        return false;
      };

      draft = snapshot(saved);
      paint();
      return () => { ctx.guard = null; };
    },
  });

})();
