// «Надиктовать» (review of 21 October 2026): a recording in the app, the same speech recognition as a voice note in
// the chat (`POST /app-api/voice`), then the person's own lines: each line one task or one purchase. No model reads
// it. Where the phone gives no microphone to the page, the same box takes the keyboard's own dictation.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;
  // Below the recognizer's three minutes (infra/gigaam/server.py): a recording right at the edge was always refused.
  const MAX_SECONDS = 170;
  const LINES_MAX = 20;
  const TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];

  const canRecord = () => Boolean(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const lines = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);

  /** `kind`: "task" or "shopping", what the lines become unless the person switches. */
  FA.dictate = function dictate(options) {
    let kind = (options && options.kind) || "task";
    let sheet = null;
    let recorder = null;
    let stream = null;
    let timer = null;
    // A recording abandoned with the sheet is thrown away, not sent to be recognized.
    let dropped = false;
    // The phone is asking for the microphone: a second tap meanwhile does not ask again.
    let asking = false;
    const errors = el("div");
    const box = el("textarea", "text-input dictate-text");
    box.id = "dictate-text";
    box.rows = 6;
    box.placeholder = "Каждая строка — отдельная запись";
    box.setAttribute("aria-label", "Что записать, по строке на запись");
    const status = el("p", "sheet-text dictate-status");
    status.setAttribute("aria-live", "polite");
    const record = button("dictate-record", "");
    record.setAttribute("aria-label", "Записать голос");
    record.append(FA.icon("mic"));
    // One nonce per line per sheet: «Повторить» after a lost answer does not add the same line twice.
    const nonces = new Map();

    function paintMain() {
      // Twenty lines go at a time; the rest stay in the box for the next tap instead of being lost.
      const count = Math.min(lines(box.value).length, LINES_MAX);
      sheet.setMain({
        disabled: count === 0 || Boolean(recorder),
        onClick: save,
        text: count === 0 ? "Добавить" : "Добавить " + FA.count(count, kind === "task" ? FA.TASKS : ["покупку", "покупки", "покупок"]),
      });
    }

    function stopStream() {
      if (stream) stream.getTracks().forEach((track) => track.stop());
      stream = null;
      clearInterval(timer);
      timer = null;
    }

    async function start() {
      errors.replaceChildren();
      if (asking) return;
      asking = true;
      let granted;
      try {
        granted = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (_) {
        if (dropped) return;
        status.textContent = "Микрофон не открылся. Можно надиктовать с клавиатуры: значок микрофона на ней.";
        box.focus();
        return;
      } finally {
        asking = false;
      }
      // The sheet closed while the phone was asking: the microphone it gave is let go at once, not recorded.
      if (dropped) {
        granted.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = granted;
      const type = TYPES.find((candidate) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidate));
      recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
      const chunks = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        const blob = new Blob(chunks, { type: (recorder.mimeType || type || "audio/webm").split(";")[0] });
        recorder = null;
        stopStream();
        record.classList.remove("is-recording");
        record.setAttribute("aria-label", "Записать голос");
        if (!dropped) send(blob);
      });
      const began = Date.now();
      recorder.start();
      record.classList.add("is-recording");
      record.setAttribute("aria-label", "Остановить запись");
      status.textContent = "Говорите… Нажмите ещё раз, когда закончите.";
      FA.haptic("select");
      timer = setInterval(() => {
        const seconds = Math.floor((Date.now() - began) / 1000);
        status.textContent = "Говорите… " + Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
        if (seconds >= MAX_SECONDS && recorder) recorder.stop();
      }, 500);
      paintMain();
    }

    async function send(blob) {
      status.textContent = "Распознаю…";
      record.disabled = true;
      try {
        const { text } = await FA.postBytes("/app-api/voice", blob);
        box.value = (box.value.trim() ? box.value.trim() + "\n" : "") + text.trim();
        status.textContent = "Проверьте текст: разбейте на строки, если это несколько записей.";
        FA.haptic("success");
      } catch (error) {
        status.textContent = "";
        FA.failed(error, errors, () => send(blob));
      } finally {
        record.disabled = false;
        paintMain();
      }
    }

    async function save() {
      const all = lines(box.value);
      const items = all.slice(0, LINES_MAX);
      const rest = all.slice(LINES_MAX);
      if (items.length === 0) return;
      await sheet.main.run(async () => {
        errors.replaceChildren();
        FA.lockForm(sheet.body, true);
        let added = 0;
        try {
          if (kind === "shopping") {
            const key = "shopping\n" + items.join("\n");
            if (!nonces.has(key)) nonces.set(key, FA.nonce());
            await FA.post("/app-api/shopping", { title: items.join("\n") }, nonces.get(key));
            added = items.length;
          } else {
            for (const title of items) {
              if (!nonces.has(title)) nonces.set(title, FA.nonce());
              await FA.post("/app-api/tasks", { title }, nonces.get(title));
              added += 1;
            }
            FA.board.invalidate();
          }
          FA.haptic("success");
          FA.toast(kind === "task" ? "Записала " + FA.count(added, FA.TASKS) : "Добавила в покупки: " + added);
          if (rest.length > 0) {
            FA.lockForm(sheet.body, false);
            box.value = rest.join("\n");
            status.textContent = "Осталось " + FA.count(rest.length, ["строка", "строки", "строк"]) + ": нажмите «Добавить» ещё раз.";
            paintMain();
            return;
          }
          sheet.close();
          FA.refresh();
        } catch (error) {
          FA.lockForm(sheet.body, false);
          // What went in stays out of the box, so «Повторить» sends only the rest.
          if (added > 0) box.value = all.slice(added).join("\n");
          FA.failed(error, errors, save);
          paintMain();
        }
      });
    }

    sheet = FA.openSheet({
      build(body) {
        const choice = FA.radioGroup({
          onChange: (value) => {
            kind = value;
            paintMain();
          },
          options: [["task", "Дела"], ["shopping", "Покупки"]],
          value: kind,
        });
        if (canRecord()) {
          const row = el("div", "dictate-row");
          status.textContent = "Нажмите и говорите";
          row.append(record, status);
          record.addEventListener("click", () => (recorder ? recorder.stop() : start()));
          body.append(row);
        } else {
          status.textContent = "Нажмите микрофон на клавиатуре и говорите.";
          body.append(status);
        }
        body.append(box, choice.node, errors);
        box.addEventListener("input", paintMain);
      },
      main: { disabled: true, onClick: () => save(), text: "Добавить" },
      onClose: () => {
        dropped = true;
        if (recorder) recorder.stop();
        stopStream();
      },
      title: "Надиктовать",
    });
    paintMain();
  };
})();
