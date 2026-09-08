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
      await browser.browserAction.setTitle({ title: i18n("actionTitle") + "\n" + doi, tabId });
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

  // Shown only on pages where a DOI was found, i.e. article pages of
  // journals, databases, conference proceedings and the like.
  async function updatePageAction(tabId, doi) {
    try {
      if (doi) {
        await browser.pageAction.setTitle({ title: i18n("actionTitle") + "\n" + doi, tabId });
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

  const inflight = new Map();

  /** Opens `url` per the openIn setting and returns the tab it went to. */
  async function openUrl(url, openerTab, openIn) {
    if (openIn === "currentTab" && openerTab && openerTab.id !== undefined) {
      try {
        return await browser.tabs.update(openerTab.id, { url });
      } catch (e) {
        // fall through to a new tab
      }
    }
    const props = { url, active: true };
    if (openerTab && openerTab.id !== undefined && openerTab.id !== browser.tabs.TAB_ID_NONE) {
      props.openerTabId = openerTab.id;
      props.index = openerTab.index + 1;
      if (openerTab.windowId !== undefined) props.windowId = openerTab.windowId;
    }
    try {
      return await browser.tabs.create(props);
    } catch (e) {
      return browser.tabs.create({ url, active: true });
    }
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

  /** Resolves the PDF for `doi` and opens it (or the Sci-Hub page as fallback). */
  function openDoi(doi, openerTab) {
    if (inflight.has(doi)) return inflight.get(doi);
    const tabId = openerTab ? openerTab.id : undefined;

    const task = (async () => {
      const s = await settings();
      const mirror = S.activeMirror(s);
      await setBusy(tabId, true);
      let result;
      try {
        result = await H.resolvePdf(mirror, doi, s.timeoutMs);
      } finally {
        await setBusy(tabId, false);
      }
      if (result.pdfUrl) {
        await openUrl(result.pdfUrl, openerTab, s.openIn);
        return result;
      }
      // No PDF (not in Sci-Hub, robot check, mirror down): open the plain
      // Sci-Hub page so the user sees what happened there.
      console.info("Sci-Hub PDF Opener: no direct PDF for", doi, result);
      const tab = await openUrl(result.articleUrl, openerTab, s.openIn);
      if (tab && tab.id !== undefined) rememberFallbackTab(tab.id, result.articleUrl);
      return result;
    })();

    inflight.set(doi, task);
    task.finally(() => inflight.delete(doi)).catch(() => {});
    return task;
  }

  async function doiForTab(tab) {
    if (!tab) return null;
    let response = null;
    try {
      response = await browser.tabs.sendMessage(tab.id, { type: "getDoi" });
    } catch (e) {
      // No content script here (about:, PDF viewer, restricted pages).
    }
    if (response && response.primary) return response.primary;
    return D.extractDoiFromUrl(tab.url || "");
  }

  async function openForTab(tab) {
    const doi = await doiForTab(tab);
    if (!doi) {
      console.info("Sci-Hub PDF Opener: no DOI found on", tab && tab.url);
      return;
    }
    await openDoi(doi, tab);
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

  browser.browserAction.onClicked.addListener((tab) => {
    openForTab(tab).catch(console.error);
  });

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
      return Promise.all([setBadge(sender.tab.id, msg.doi), updatePageAction(sender.tab.id, msg.doi)]);
    }
    if (msg.type === "scihubPdf" && sender.tab && msg.url) {
      return redirectFallbackTab(sender.tab.id, sender.url || sender.tab.url || "", msg.url);
    }
    if (msg.type === "openDoi" && msg.doi) {
      return activeTab().then((tab) => openDoi(msg.doi, tab));
    }
    return undefined;
  });

  browser.tabs.onUpdated.addListener(
    (tabId, changeInfo) => {
      if (changeInfo.status === "loading") {
        knownDois.delete(tabId);
        clearBadge(tabId);
        updatePageAction(tabId, null);
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
