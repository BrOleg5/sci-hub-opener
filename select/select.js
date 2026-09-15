/*
 * Selection window for list pages (search results, tables of contents,
 * reading lists), modelled on the Zotero connector's "Select Items" dialog.
 */
(function () {
  "use strict";

  const i18n = (key, subs) => browser.i18n.getMessage(key, subs) || "";
  const $ = (id) => document.getElementById(id);
  const tabId = Number(new URLSearchParams(location.search).get("tab"));

  for (const el of document.querySelectorAll("[data-i18n]")) {
    const text = i18n(el.dataset.i18n);
    if (text) el.textContent = text;
  }
  document.title = i18n("selectHeading") || document.title;

  function checkboxes() {
    return [...document.querySelectorAll(".item input")];
  }

  function selectedDois() {
    return checkboxes()
      .filter((el) => el.checked)
      .map((el) => el.value);
  }

  function updateOpenButton() {
    const count = selectedDois().length;
    $("open").disabled = count === 0;
    $("open").textContent = count ? i18n("selectOpenCount", [String(count)]) : i18n("selectOpen");
  }

  function renderItems(items) {
    const list = $("list");
    list.textContent = "";
    for (const item of items) {
      const row = document.createElement("label");
      row.className = "item";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = item.doi;
      checkbox.addEventListener("change", updateOpenButton);

      const text = document.createElement("span");
      text.className = "text";
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = item.title || item.doi;
      text.append(title);
      if (item.title) {
        const doi = document.createElement("span");
        doi.className = "doi";
        doi.textContent = item.doi;
        text.append(doi);
      }

      row.append(checkbox, text);
      list.append(row);
    }
    list.hidden = items.length === 0;
    $("empty").hidden = items.length > 0;
    $("select-all").disabled = $("deselect-all").disabled = items.length === 0;
    updateOpenButton();
  }

  function setAll(checked) {
    for (const el of checkboxes()) el.checked = checked;
    updateOpenButton();
  }

  async function openSelected() {
    const dois = selectedDois();
    if (!dois.length) return;
    try {
      await browser.runtime.sendMessage({ type: "openDois", tabId, dois });
    } finally {
      window.close();
    }
  }

  $("select-all").addEventListener("click", () => setAll(true));
  $("deselect-all").addEventListener("click", () => setAll(false));
  $("cancel").addEventListener("click", () => window.close());
  $("open").addEventListener("click", () => openSelected().catch(console.error));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.close();
    if (e.key === "Enter" && !$("open").disabled) openSelected().catch(console.error);
  });

  async function load() {
    let response = null;
    try {
      response = await browser.runtime.sendMessage({ type: "getTabItems", tabId });
    } catch (e) {
      // background not reachable
    }
    if (response && response.pageTitle) $("page").textContent = response.pageTitle;
    renderItems((response && response.items) || []);
  }

  load().catch(console.error);
})();
