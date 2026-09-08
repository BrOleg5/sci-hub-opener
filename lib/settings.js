/*
 * Settings storage (browser.storage.sync). Shared by background and options.
 */
(function (root) {
  "use strict";

  const DEFAULT_MIRRORS = [
    "sci-hub.se",
    "sci-hub.st",
    "sci-hub.ru",
    "sci-hub.red",
    "sci-hub.box",
    "sci-hub.ren",
    "sci-hub.ee"
  ];

  const CUSTOM = "custom";

  const DEFAULTS = {
    // Either one of `mirrors` or the literal "custom".
    mirror: DEFAULT_MIRRORS[0],
    customMirror: "",
    mirrors: DEFAULT_MIRRORS.slice(),
    openIn: "newTab", // "newTab" | "currentTab"
    showBadge: true,
    timeoutMs: 15000
  };

  /** "sci-hub.se", "https://sci-hub.se/" -> "https://sci-hub.se" ("" if empty). */
  function normalizeMirror(value) {
    let m = String(value || "").trim();
    if (!m) return "";
    if (!/^https?:\/\//i.test(m)) m = "https://" + m;
    try {
      const u = new URL(m);
      return u.origin + u.pathname.replace(/\/+$/, "");
    } catch (e) {
      return "";
    }
  }

  /** Display form without protocol, e.g. "sci-hub.se". */
  function displayMirror(value) {
    return normalizeMirror(value).replace(/^https?:\/\//i, "");
  }

  function sanitizeMirrorList(list) {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      const d = displayMirror(item);
      if (d && !out.includes(d)) out.push(d);
    }
    return out.length ? out : DEFAULT_MIRRORS.slice();
  }

  async function get() {
    const stored = await browser.storage.sync.get(null);
    const settings = Object.assign({}, DEFAULTS, stored);
    settings.mirrors = sanitizeMirrorList(settings.mirrors);
    if (settings.mirror !== CUSTOM && !settings.mirrors.includes(settings.mirror)) {
      settings.mirror = settings.mirrors[0];
    }
    return settings;
  }

  function set(patch) {
    return browser.storage.sync.set(patch);
  }

  /** Base URL of the mirror to use, e.g. "https://sci-hub.se". */
  function activeMirror(settings) {
    if (settings.mirror === CUSTOM) {
      const custom = normalizeMirror(settings.customMirror);
      if (custom) return custom;
    }
    const listed = settings.mirrors.includes(settings.mirror) ? settings.mirror : settings.mirrors[0];
    return normalizeMirror(listed);
  }

  root.SciHubSettings = {
    DEFAULT_MIRRORS,
    DEFAULTS,
    CUSTOM,
    get,
    set,
    activeMirror,
    normalizeMirror,
    displayMirror,
    sanitizeMirrorList
  };
})(globalThis);
