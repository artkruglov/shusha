// Mini App icons (docs/design/style-guide.ru.md §4.4): one stroke set, 24×24, currentColor.
// The markup below is constant and ours; it is parsed once per name and cloned, so no text from people
// or the server ever reaches a parser. Icons repeat a visible word, so they are aria-hidden by default.
"use strict";

(function () {
  const FA = window.FamilyApp = window.FamilyApp || {};
  const SVG = "http://www.w3.org/2000/svg";
  const DOT = 'fill="currentColor" stroke="none"';

  const PATHS = {
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    checkbox: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="m8 12.2 2.8 2.8L16.2 9.4"/>',
    sparkle: '<path d="M12 3c.8 5 4 8.2 9 9-5 .8-8.2 4-9 9-.8-5-4-8.2-9-9 5-.8 8.2-4 9-9Z"/>',
    dots: `<circle cx="5" cy="12" r="1.7" ${DOT}/><circle cx="12" cy="12" r="1.7" ${DOT}/><circle cx="19" cy="12" r="1.7" ${DOT}/>`,
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    "check-circle": '<circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.8 2.8 5.2-5.6"/>',
    "minus-circle": '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
    warning: '<path d="M10.3 4.2 2.6 17.5a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/>',
    "chevron-right": '<path d="m9 5 7 7-7 7"/>',
    "chevron-left": '<path d="m15 5-7 7 7 7"/>',
    "chevron-down": '<path d="m5 9 7 7 7-7"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
    "person-send": '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 9.5-4.9"/><path d="M15 18h6M18.5 15.5 21 18l-2.5 2.5"/>',
    folder: '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
    notebook: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3v18M12.5 8h3M12.5 12h3"/>',
    bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5Z"/>',
    repeat: '<path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11.5V10a4 4 0 0 1 4-4h13"/><path d="M7 21.5 3.5 18 7 14.5"/><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13"/>',
    cart: '<circle cx="9" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/><path d="M2.5 3.5h3l2.4 11.5a1.5 1.5 0 0 0 1.5 1.2h8.4a1.5 1.5 0 0 0 1.5-1.2L21 7H6.3"/>',
    link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
    download: '<path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5"/><path d="M4 16.5v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
    chat: '<path d="M20.5 12a8.5 8.5 0 0 1-12.6 7.4l-4.4 1.1 1.1-4.3A8.5 8.5 0 1 1 20.5 12Z"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8 7.5 9.5 4.3-1.5 7.5-4.9 7.5-9.5V6Z"/>',
    trash: '<path d="M4 6.5h16M9.5 6.5v-2h5v2M6 6.5l1 13a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5l1-13M10 10.5v6M14 10.5v6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3"/>',
    edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
    sofa: '<path d="M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3"/><path d="M3 13a2 2 0 0 1 4 0v2h10v-2a2 2 0 0 1 4 0v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M6 18v2M18 18v2"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    table: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9.5h17M3.5 15h17M9.5 9.5V20"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m21 16-5-5-9 9"/>',
    wand: '<path d="m4 20 11-11M13.5 6.5l2-2 4 4-2 2"/><path d="M8 3v3M6.5 4.5h3M19 14v3M17.5 15.5h3"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4"/>',
    list: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="m3.5 6 1.3 1.3L7.3 4.8M3.5 12l1.3 1.3 2.5-2.5M3.5 18l1.3 1.3 2.5-2.5"/>',
    leaf: '<path d="M5 19C5 11 10 5 20 5c0 10-6 15-14 15"/><path d="M5 19c3-4 6-6.5 9.5-8.5"/>',
    camera: '<path d="M4 8h3l2-2.5h6L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/>',
    bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z"/>',
    send: '<path d="M21 3 10 14"/><path d="M21 3 14.5 21l-4.5-7-7-4.5Z"/>',
    window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M6.5 6.5h.01M9 6.5h.01"/>',
    columns: '<rect x="3" y="4" width="7.5" height="16" rx="1.5"/><rect x="13.5" y="4" width="7.5" height="16" rx="1.5"/>',
    scale: '<path d="M12 4v16M7 20h10M5 7h14"/><path d="m5 7-2.5 6a2.5 2.5 0 0 0 5 0ZM19 7l-2.5 6a2.5 2.5 0 0 0 5 0Z"/>',
    heart: '<path d="M12 20s-7.5-4.5-7.5-10A4.3 4.3 0 0 1 12 7.5 4.3 4.3 0 0 1 19.5 10c0 5.5-7.5 10-7.5 10Z"/>',
    chart: '<path d="M4 4v16h16"/><path d="M8.5 16v-4M12.5 16V8M16.5 16v-6"/>',
    question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/>',
    news: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9h10M7 12.5h10M7 16h6"/>',
    bookmark: '<path d="M6 3.5h12v17l-6-4-6 4Z"/>',
    cap: '<path d="m2.5 9 9.5-4.5L21.5 9 12 13.5Z"/><path d="M6.5 11v5c3 2.5 8 2.5 11 0v-5M21.5 9v5"/>',
    megaphone: '<path d="M3.5 10v4h3l8 4.5v-13l-8 4.5Z"/><path d="M18 9a4 4 0 0 1 0 6"/>',
    lines: '<path d="M4 6h16M4 10h16M4 14h10M4 18h7"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    "home-heart": '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M12 17.2s-3-1.9-3-4a1.6 1.6 0 0 1 3-.8 1.6 1.6 0 0 1 3 .8c0 2.1-3 4-3 4Z"/>',
    checklist: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="m7 8.5 1.3 1.3L10.8 7.3M7 14.5l1.3 1.3 2.5-2.5M13 9h4M13 15h4"/>',
    home: '<path d="M3.5 10.8 12 4l8.5 6.8V19a1.5 1.5 0 0 1-1.5 1.5h-4v-6h-6v6H5A1.5 1.5 0 0 1 3.5 19Z"/>',
    "send-up": '<path d="M12 19V5M6 11l6-6 6 6"/>',
    palette: '<path d="M12 3a9 9 0 0 0 0 18c1.4 0 2-1 2-2 0-1.5-1.2-1.6-1.2-3 0-1.1.9-2 2-2H17a4 4 0 0 0 4-4c0-4-4-7-9-7Z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="15" cy="7" r="1.2"/>',
    phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    lock: '<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    basket: '<path d="M3 10h18l-1.8 9a1.5 1.5 0 0 1-1.5 1.2H6.3A1.5 1.5 0 0 1 4.8 19Z"/><path d="m8 10 3-6M16 10l-3-6M9 14v3M15 14v3"/>',
  };

  const parsed = {};

  function template(name) {
    if (!parsed[name]) {
      const source = `<svg xmlns="${SVG}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ` +
        `stroke-linecap="round" stroke-linejoin="round">${PATHS[name] || PATHS.dots}</svg>`;
      parsed[name] = new DOMParser().parseFromString(source, "image/svg+xml").documentElement;
    }
    return parsed[name];
  }

  /** An inline SVG icon; `size` in CSS px (20–24 in a 44px target), decorative unless a label is given. */
  FA.icon = function icon(name, className, label) {
    const node = document.importNode(template(name), true);
    node.setAttribute("class", "icon" + (className ? " " + className : ""));
    if (label) {
      node.setAttribute("role", "img");
      node.setAttribute("aria-label", label);
    } else {
      node.setAttribute("aria-hidden", "true");
      node.setAttribute("focusable", "false");
    }
    return node;
  };
})();
