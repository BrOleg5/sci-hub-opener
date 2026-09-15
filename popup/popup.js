/*
 * Toolbar popup: opens the PDF for the DOI of the current tab (or a typed
 * DOI) and holds all settings. Also used as the options page.
 */
(function () {
  "use strict";

  const S = globalThis.SciHubSettings;
  const D = globalThis.SciHubDoi;
  const i18n = (key, subs) => browser.i18n.getMessage(key, subs) || "";
  const $ = (id) => document.getElementById(id);

  /* ---------- i18n ---------- */

  for (const el of document.querySelectorAll("[data-i18n]")) {
    const text = i18n(el.dataset.i18n);
    if (text) el.textContent = text;
  }

  /* ---------- helpers ---------- */

  let savedTimer = null;
  function flashSaved() {
    const el = $("saved");
    el.classList.add("visible");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.remove("visible"), 1200);
  }

  async function save(patch) {
    await S.set(patch);
    flashSaved();
  }

  /* ---------- open PDF for current tab / typed DOI ---------- */

  async function loadTabDois() {
    const input = $("doi");
    let result = { primary: null, all: [] };
    try {
      result = (await browser.runtime.sendMessage({ type: "getTabDois" })) || result;
    } catch (e) {
      // background not reachable; leave the field empty
    }
    $("open").disabled = false;
    if (result.primary) {
      input.value = result.primary;
    } else if (result.all.length > 1) {
      input.placeholder = i18n("popupTypeDoi");
      showSelectButton(result.all.length);
    } else {
      input.placeholder = i18n("popupNoDoi");
    }
  }

  // List page (search results, table of contents, …): pick in the selection window.
  function showSelectButton(count) {
    const button = $("select-articles");
    button.textContent = i18n("popupSelectArticles", [String(count)]);
    button.addEventListener("click", async () => {
      try {
        await browser.runtime.sendMessage({ type: "openSelectWindow" });
      } finally {
        window.close();
      }
    });
    button.hidden = false;
  }

  async function openDoi(doi) {
    await browser.runtime.sendMessage({ type: "openDoi", doi });
    window.close();
  }

  async function openPdf() {
    const doi = D.extractDoi($("doi").value);
    if (!doi) {
      $("doi").focus();
      return;
    }
    await openDoi(doi);
  }

  $("open").addEventListener("click", () => openPdf().catch(console.error));
  $("doi").addEventListener("keydown", (e) => {
    if (e.key === "Enter") openPdf().catch(console.error);
  });

  /* ---------- mirror radios ---------- */

  function renderMirrors(settings) {
    const list = $("mirror-list");
    list.textContent = "";
    for (const m of settings.mirrors) {
      const label = document.createElement("label");
      label.className = "mirror-row";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "mirror";
      radio.value = m;
      radio.checked = settings.mirror === m;
      radio.addEventListener("change", () => save({ mirror: m }));

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = m;

      const status = document.createElement("span");
      status.className = "status";
      status.id = "status-" + m;

      label.append(radio, name, status);
      list.append(label);
    }
    $("mirror-custom").checked = settings.mirror === S.CUSTOM;
    $("custom-mirror").value = settings.customMirror || "";
    $("mirrors-text").value = settings.mirrors.join("\n");
  }

  $("mirror-custom").addEventListener("change", () => {
    if ($("mirror-custom").checked) save({ mirror: S.CUSTOM });
  });

  let customTimer = null;
  $("custom-mirror").addEventListener("input", () => {
    clearTimeout(customTimer);
    customTimer = setTimeout(() => {
      const value = $("custom-mirror").value.trim();
      const patch = { customMirror: value };
      if (value) {
        patch.mirror = S.CUSTOM;
        $("mirror-custom").checked = true;
      }
      save(patch);
    }, 400);
  });

  /* ---------- mirror list editing ---------- */

  async function saveMirrorList(mirrors) {
    const settings = await S.get();
    const patch = { mirrors };
    if (settings.mirror !== S.CUSTOM && !mirrors.includes(settings.mirror)) {
      patch.mirror = mirrors[0];
    }
    await save(patch);
  }

  $("save-mirrors").addEventListener("click", () => {
    const lines = $("mirrors-text").value.split(/\r?\n/);
    saveMirrorList(S.sanitizeMirrorList(lines)).catch(console.error);
  });

  $("reset-mirrors").addEventListener("click", () => {
    saveMirrorList(S.DEFAULT_MIRRORS.slice()).catch(console.error);
  });

  /* ---------- availability check ---------- */

  async function probe(base) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const started = performance.now();
    try {
      const resp = await fetch(base + "/", {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
        signal: controller.signal
      });
      const ms = Math.round(performance.now() - started);
      return { ok: resp.ok, status: resp.status, ms };
    } catch (e) {
      return { ok: false, status: e.name === "AbortError" ? "timeout" : "error", ms: null };
    } finally {
      clearTimeout(timer);
    }
  }

  function setStatus(el, result) {
    if (!el) return;
    el.classList.remove("ok", "fail");
    if (!result) {
      el.textContent = "…";
      return;
    }
    el.classList.add(result.ok ? "ok" : "fail");
    el.textContent = result.ok
      ? "✓ " + result.ms + " ms"
      : "✗ " + (result.status === "timeout" ? i18n("optTimeoutShort") : String(result.status));
  }

  $("check-mirrors").addEventListener("click", async () => {
    const button = $("check-mirrors");
    button.disabled = true;
    $("check-note").textContent = i18n("optChecking");
    const settings = await S.get();
    const targets = settings.mirrors.map((m) => ({ id: "status-" + m, base: S.normalizeMirror(m) }));
    const custom = S.normalizeMirror(settings.customMirror);
    if (custom) targets.push({ id: "status-custom", base: custom });

    for (const t of targets) setStatus($(t.id), null);
    await Promise.all(
      targets.map(async (t) => {
        const result = await probe(t.base);
        setStatus($(t.id), result);
      })
    );
    $("check-note").textContent = i18n("optCheckDone");
    button.disabled = false;
  });

  /* ---------- behaviour ---------- */

  $("open-in").addEventListener("change", () => save({ openIn: $("open-in").value }));
  $("show-badge").addEventListener("change", () => save({ showBadge: $("show-badge").checked }));
  $("timeout").addEventListener("change", () => {
    const seconds = Math.min(120, Math.max(3, Number($("timeout").value) || 15));
    $("timeout").value = seconds;
    save({ timeoutMs: seconds * 1000 });
  });

  /* ---------- init ---------- */

  async function load() {
    const settings = await S.get();
    renderMirrors(settings);
    $("open-in").value = settings.openIn;
    $("show-badge").checked = !!settings.showBadge;
    $("timeout").value = Math.round((settings.timeoutMs || 15000) / 1000);
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.mirrors || changes.mirror || changes.customMirror) {
      if (document.activeElement !== $("custom-mirror")) load();
    }
  });

  $("open").disabled = true;
  load().catch(console.error);
  loadTabDois().catch(console.error);
})();
