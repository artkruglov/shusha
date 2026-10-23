// A photo from the phone into the person's folder (POST /app-api/studio/upload?nonce=…, raw JPEG bytes).
// The picture is redrawn on a canvas first: at most 2048 px on the long side, JPEG at 0.85. That keeps it
// small and turns whatever the phone gave (HEIC on an iPhone, a huge PNG) into something the server takes.
// One chosen photo is one upload: «Повторить» resends the same bytes with the same nonce, which the server
// answers with the same file.
"use strict";

(function () {
  const FA = window.FamilyApp;
  const { el, button } = FA;
  const LONG_SIDE = 2048;
  const MAX_BYTES = 10 * 1024 * 1024;

  async function decode(file) {
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch (_) { /* fall back to an <img> */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const toBlob = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));

  /** The chosen file as a JPEG within 2048 px and 10 MB; an error the person can read when it is not a picture. */
  FA.prepareImage = async function prepareImage(file) {
    let picture;
    try {
      picture = await decode(file);
    } catch (_) {
      throw new Error("Это фото не открылось. Выберите другое или пришлите его в чат.");
    }
    const width = picture.width;
    const height = picture.height;
    const scale = Math.min(1, LONG_SIDE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d").drawImage(picture, 0, 0, canvas.width, canvas.height);
    if (typeof picture.close === "function") picture.close();
    let blob = await toBlob(canvas, 0.85);
    if (blob && blob.size > MAX_BYTES) blob = await toBlob(canvas, 0.7);
    if (!blob || blob.size > MAX_BYTES) throw new Error("Фото слишком большое. Выберите другое.");
    return blob;
  };

  /**
   * «Загрузить» / «С телефона»: a button that opens the phone's picker (camera or library: no `capture`),
   * prepares the photo and uploads it. `onUploaded(file, blob)` gets the gallery item
   * ({kind, scope, path, name, at}) and the prepared bytes for an instant local preview.
   * `place` shows the error, with «Повторить» on the same nonce and bytes.
   */
  FA.uploadButton = function uploadButton(options) {
    const input = el("input", "visually-hidden");
    input.type = "file";
    input.accept = "image/*";
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    const node = button(options.className || "link-button upload-button", "", () => input.click());
    node.append(FA.icon("download", "upload-icon"), el("span", null, options.label || "Загрузить"));
    if (options.ariaLabel) node.setAttribute("aria-label", options.ariaLabel);

    async function send(blob, nonce) {
      const old = options.place.querySelector(":scope > .inline-error");
      if (old) old.remove();
      try {
        const saved = await FA.busy(node, () => FA.postBytes("/app-api/studio/upload?nonce=" + encodeURIComponent(nonce), blob));
        FA.haptic("success");
        options.onUploaded({ at: new Date().toISOString(), kind: "image", name: saved.path.split("/").pop(), path: saved.path, scope: saved.scope }, blob);
      } catch (error) {
        FA.failed(error, options.place, error.status === 429 || error.status === 400 ? null : () => send(blob, nonce));
      }
    }

    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      let blob;
      try {
        blob = await FA.busy(node, () => FA.prepareImage(file));
      } catch (error) {
        FA.failed(error, options.place);
        return;
      }
      send(blob, FA.nonce());
    });
    const wrap = el("span", "upload-wrap");
    wrap.append(node, input);
    return wrap;
  };
})();
