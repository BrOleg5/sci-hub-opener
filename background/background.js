/*
 * Background page: context menus, toolbar button, keyboard command,
 * Sci-Hub PDF resolution and tab handling.
 */
(function () {
  "use strict";

  const D = globalThis.SciHubDoi;
  const S = globalThis.SciHubSettings;
  const H = globalThis.SciHub;

  const MENU = {
    link: "scihub-open-link",
    selection: "scihub-open-selection",
    page: "scihub-open-page"
  };

  const BADGE_COLOR = "#1f6feb";

  const i18n = (key, subs) => browser.i18n.getMessage(key, subs) || key;

  let settingsCache = null;
  async function settings() {
    if (!settingsCache) settingsCache = await S.get();
    return settingsCache;
  }

  /* ---------- badge ---------- */

  async function setBadge(tabId, doi) {
    const s = await settings();
    if (!s.showBadge || !doi) return clearBadge(tabId);
    try {
      await browser.browserAction.setBadgeText({ text: "DOI", tabId });
      await browser.browserAction.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId });
      await browser.browserAction.setTitle({ title: i18n("extName") + "\n" + doi, tabId });
    } catch (e) {
      // Tab may have been closed meanwhile.
    }
  }

  async function clearBadge(tabId) {
    try {
      await browser.browserAction.setBadgeText({ text: "", tabId });
      await browser.browserAction.setTitle({ title: null, tabId });
    } catch (e) {
      // ignore
    }
  }

  /* ---------- page action (address-bar button) ---------- */

  const ARTICLE_ICON = { 16: "icons/icon-16.png", 32: "icons/icon-32.png" };
  const LIST_ICON = { 16: "icons/list-16.png", 32: "icons/list-32.png" };

  // Article pages (journals, databases, proceedings, …): opens the PDF.
  // List pages (several DOIs, no article DOI): a folder icon that opens the
  // selection window, like the Zotero connector. Hidden everywhere else.
  async function updatePageAction(tabId, doi, count) {
    try {
      if (doi) {
        await browser.pageAction.setIcon({ path: ARTICLE_ICON, tabId });
        await browser.pageAction.setTitle({ title: i18n("actionTitle") + "\n" + doi, tabId });
        await browser.pageAction.show(tabId);
      } else if (count > 1) {
        await browser.pageAction.setIcon({ path: LIST_ICON, tabId });
        await browser.pageAction.setTitle({ title: i18n("actionTitleList", [String(count)]), tabId });
        await browser.pageAction.show(tabId);
      } else {
        await browser.pageAction.hide(tabId);
      }
    } catch (e) {
      // Tab may have been closed meanwhile.
    }
  }

  async function setBusy(tabId, busy) {
    if (tabId === undefined) return;
    try {
      if (busy) {
        await browser.browserAction.setBadgeText({ text: "…", tabId });
        await browser.browserAction.setBadgeBackgroundColor({ color: "#6e7781", tabId });
      } else {
        const doi = knownDois.get(tabId);
        if (doi) await setBadge(tabId, doi);
        else await clearBadge(tabId);
      }
    } catch (e) {
      // ignore
    }
  }

  const knownDois = new Map();

  /* ---------- opening ---------- */

  const opening = new Map(); // doi -> promise, guards against double clicks
  const MAX_PARALLEL_RESOLVES = 3;

  /**
   * Opens `url` and returns the tab it went to.
   * options: openIn ("newTab" | "currentTab"), index (new tab position), active.
   */
  async function openUrl(url, openerTab, options) {
    const { openIn = "newTab", index, active = true } = options || {};
    if (openIn === "currentTab" && openerTab && openerTab.id !== undefined) {
      try {
        return await browser.tabs.update(openerTab.id, { url });
      } catch (e) {
        // fall through to a new tab
      }
    }
    const props = { url, active };
    if (openerTab && openerTab.id !== undefined && openerTab.id !== browser.tabs.TAB_ID_NONE) {
      props.openerTabId = openerTab.id;
      props.index = index !== undefined ? index : openerTab.index + 1;
      if (openerTab.windowId !== undefined) props.windowId = openerTab.windowId;
    }
    try {
      return await browser.tabs.create(props);
    } catch (e) {
      return browser.tabs.create({ url, active });
    }
  }

  /** Runs `fn` over `items` with at most `limit` calls in flight; promises keep item order. */
  function mapLimited(items, limit, fn) {
    const queue = [];
    let running = 0;
    const next = () => {
      if (running >= limit || !queue.length) return;
      running++;
      const job = queue.shift();
      Promise.resolve()
        .then(() => fn(job.item))
        .then(job.resolve, job.reject)
        .finally(() => {
          running--;
          next();
        });
    };
    return items.map(
      (item) =>
        new Promise((resolve, reject) => {
          queue.push({ item, resolve, reject });
          next();
        })
    );
  }

  // Tabs where the plain Sci-Hub page was opened as a fallback. When the page
  // there eventually embeds a PDF (after a captcha), jump to the PDF directly.
  const FALLBACK_TTL_MS = 15 * 60 * 1000;
  const fallbackTabs = new Map(); // tabId -> { host, expires }

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (e) {
      return "";
    }
  }

  function rememberFallbackTab(tabId, articleUrl) {
    fallbackTabs.set(tabId, { host: hostOf(articleUrl), expires: Date.now() + FALLBACK_TTL_MS });
  }

  async function redirectFallbackTab(tabId, pageUrl, pdfUrl) {
    const entry = fallbackTabs.get(tabId);
    if (!entry) return;
    // Only act while the tab is still on the mirror we sent it to.
    if (entry.expires < Date.now() || hostOf(pageUrl) !== entry.host || hostOf(pdfUrl) !== entry.host) {
      if (entry.expires < Date.now()) fallbackTabs.delete(tabId);
      return;
    }
    fallbackTabs.delete(tabId);
    try {
      await browser.tabs.update(tabId, { url: pdfUrl });
    } catch (e) {
      // tab gone
    }
  }

  async function resolveDoi(doi) {
    const s = await settings();
    return H.resolvePdf(S.activeMirror(s), doi, s.timeoutMs);
  }

  /** Opens a resolved DOI: the PDF, or the plain Sci-Hub page as fallback. */
  async function openResult(doi, result, openerTab, options) {
    if (!result.pdfUrl) {
      // No PDF (not in Sci-Hub, robot check, mirror down): open the plain
      // Sci-Hub page so the user sees what happened there.
      console.info("Sci-Hub PDF Opener: no direct PDF for", doi, result);
    }
    const tab = await openUrl(result.pdfUrl || result.articleUrl, openerTab, options);
    if (!result.pdfUrl && tab && tab.id !== undefined) rememberFallbackTab(tab.id, result.articleUrl);
    return tab;
  }

  /** Resolves the PDF for `doi` and opens it per the openIn setting. */
  function openDoi(doi, openerTab) {
    if (opening.has(doi)) return opening.get(doi);
    const tabId = openerTab ? openerTab.id : undefined;

    const task = (async () => {
      const s = await settings();
      await setBusy(tabId, true);
      let result;
      try {
        result = await resolveDoi(doi);
      } finally {
        await setBusy(tabId, false);
      }
      return openResult(doi, result, openerTab, { openIn: s.openIn });
    })();

    opening.set(doi, task);
    task.finally(() => opening.delete(doi)).catch(() => {});
    return task;
  }

  /**
   * Opens several DOIs picked in the selection window: resolved a few at a
   * time, opened in new tabs right after the list page in the picked order.
   */
  async function openDois(dois, openerTab) {
    if (dois.length === 1) return openDoi(dois[0], openerTab);
    const tabId = openerTab ? openerTab.id : undefined;
    await setBusy(tabId, true);
    try {
      const results = mapLimited(dois, MAX_PARALLEL_RESOLVES, resolveDoi);
      let index = openerTab ? openerTab.index + 1 : undefined;
      for (let i = 0; i < dois.length; i++) {
        let result;
        try {
          result = await results[i];
        } catch (e) {
          console.error("Sci-Hub PDF Opener:", dois[i], e);
          continue;
        }
        const tab = await openResult(dois[i], result, openerTab, { index, active: i === 0 });
        if (index !== undefined && tab) index = tab.index + 1;
      }
    } finally {
      await setBusy(tabId, false);
    }
  }

  /* ---------- selection window (list pages) ---------- */

  const SELECT_WINDOW_SIZE = { width: 640, height: 640 };

  function openSelectWindow(tab) {
    return browser.windows.create({
      url: browser.runtime.getURL("select/select.html") + "?tab=" + tab.id,
      type: "popup",
      width: SELECT_WINDOW_SIZE.width,
      height: SELECT_WINDOW_SIZE.height
    });
  }

  /** Articles on a list page for the selection window: { items: [{ doi, title }], pageTitle }. */
  async function tabItems(tabId) {
    let tab = null;
    let response = null;
    try {
      tab = await browser.tabs.get(tabId);
      response = await browser.tabs.sendMessage(tabId, { type: "getDoi", withTitles: true });
    } catch (e) {
      // Tab closed or navigated to a page without the content script.
    }
    return { items: (response && response.items) || [], pageTitle: tab ? tab.title || "" : "" };
  }

  /**
   * { primary, all } for a tab. `primary` is the article DOI (null on list
   * pages), `all` every DOI found on the page.
   */
  async function doisForTab(tab) {
    if (!tab) return { primary: null, all: [] };
    try {
      const response = await browser.tabs.sendMessage(tab.id, { type: "getDoi" });
      if (response) return { primary: response.primary || null, all: response.all || [] };
    } catch (e) {
      // No content script here (about:, PDF viewer, restricted pages).
    }
    const doi = D.extractDoiFromUrl(tab.url || "");
    return { primary: doi, all: doi ? [doi] : [] };
  }

  async function doiForTab(tab) {
    return (await doisForTab(tab)).primary;
  }

  /** Address-bar button, shortcut, page menu: open the article or pick from a list. */
  async function openForTab(tab) {
    const { primary, all } = await doisForTab(tab);
    if (primary) {
      await openDoi(primary, tab);
    } else if (all.length > 1) {
      await openSelectWindow(tab);
    } else {
      console.info("Sci-Hub PDF Opener: no DOI found on", tab && tab.url);
    }
  }

  async function activeTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  /* ---------- context menus ---------- */

  async function buildMenus() {
    await browser.contextMenus.removeAll();

    // Visibility of these items is decided per menu in onShown below,
    // so no URL pattern filter here.
    browser.contextMenus.create({
      id: MENU.link,
      title: i18n("menuOpenLink"),
      contexts: ["link"]
    });
    browser.contextMenus.create({
      id: MENU.selection,
      title: i18n("menuOpenSelection"),
      contexts: ["selection"]
    });
    browser.contextMenus.create({
      id: MENU.page,
      title: i18n("menuOpenPage"),
      contexts: ["page", "browser_action"]
    });
  }

  function doiFromLink(info) {
    if (!info.linkUrl) return null;
    return D.extractDoiFromUrl(info.linkUrl) || D.cleanDOI(info.linkText || "");
  }

  function doiFromSelection(info) {
    return info.selectionText ? D.extractDoi(info.selectionText) : null;
  }

  function knownDoiForTab(tab) {
    if (!tab) return null;
    return knownDois.get(tab.id) || D.extractDoiFromUrl(tab.url || "");
  }

  // Firefox only: show the DOI items only when there is a DOI to open.
  if (browser.contextMenus.onShown && browser.contextMenus.refresh) {
    browser.contextMenus.onShown.addListener(async (info, tab) => {
      try {
        await Promise.all([
          browser.contextMenus.update(MENU.link, { visible: !!doiFromLink(info) }),
          browser.contextMenus.update(MENU.selection, { visible: !!doiFromSelection(info) }),
          browser.contextMenus.update(MENU.page, { visible: !!knownDoiForTab(tab) })
        ]);
        await browser.contextMenus.refresh();
      } catch (e) {
        // Menu may already be closed.
      }
    });
  }

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    const id = String(info.menuItemId);
    try {
      if (id === MENU.link) {
        const doi = doiFromLink(info);
        if (doi) await openDoi(doi, tab);
      } else if (id === MENU.selection) {
        const doi = doiFromSelection(info);
        if (doi) await openDoi(doi, tab);
      } else if (id === MENU.page) {
        await openForTab(tab || (await activeTab()));
      }
    } catch (e) {
      console.error("Sci-Hub PDF Opener:", e);
    }
  });

  /* ---------- events ---------- */

  // The toolbar button opens the popup (popup/popup.html); the address-bar
  // button, the keyboard command and the context menu open the PDF directly.
  browser.pageAction.onClicked.addListener((tab) => {
    openForTab(tab).catch(console.error);
  });

  browser.commands.onCommand.addListener(async (command) => {
    if (command === "open-in-scihub") {
      const tab = await activeTab();
      if (tab) openForTab(tab).catch(console.error);
    }
  });

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (!msg) return undefined;
    if (msg.type === "doiFound" && sender.tab) {
      if (msg.doi) knownDois.set(sender.tab.id, msg.doi);
      else knownDois.delete(sender.tab.id);
      return Promise.all([
        setBadge(sender.tab.id, msg.doi),
        updatePageAction(sender.tab.id, msg.doi, msg.count || 0)
      ]);
    }
    if (msg.type === "scihubPdf" && sender.tab && msg.url) {
      return redirectFallbackTab(sender.tab.id, sender.url || sender.tab.url || "", msg.url);
    }
    if (msg.type === "openDoi" && msg.doi) {
      return activeTab().then((tab) => openDoi(msg.doi, tab));
    }
    if (msg.type === "getTabDois") {
      return activeTab().then(doisForTab);
    }
    if (msg.type === "openSelectWindow") {
      return activeTab().then((tab) => tab && openSelectWindow(tab));
    }
    if (msg.type === "getTabItems" && Number.isInteger(msg.tabId)) {
      return tabItems(msg.tabId);
    }
    if (msg.type === "openDois" && Number.isInteger(msg.tabId) && Array.isArray(msg.dois)) {
      const dois = msg.dois.map((d) => D.cleanDOI(d)).filter(Boolean);
      // Fire and forget: the selection window closes right after sending.
      browser.tabs
        .get(msg.tabId)
        .catch(() => undefined)
        .then((tab) => openDois(dois, tab))
        .catch(console.error);
      return Promise.resolve();
    }
    return undefined;
  });

  browser.tabs.onUpdated.addListener(
    (tabId, changeInfo) => {
      if (changeInfo.status === "loading") {
        knownDois.delete(tabId);
        clearBadge(tabId);
        updatePageAction(tabId, null, 0);
      }
    },
    { properties: ["status"] }
  );

  browser.tabs.onRemoved.addListener((tabId) => {
    knownDois.delete(tabId);
    fallbackTabs.delete(tabId);
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    settingsCache = null;
    if (changes.showBadge) {
      for (const [tabId, doi] of knownDois) setBadge(tabId, doi);
    }
  });

  buildMenus().catch(console.error);
})();
