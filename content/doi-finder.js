/*
 * Content script: finds the DOI(s) of the current page the same way the
 * Zotero connector does (embedded metadata, JSON-LD, URL, links, page text).
 */
(function () {
  "use strict";

  if (window.__sciHubDoiFinderLoaded) return;
  window.__sciHubDoiFinderLoaded = true;

  const D = globalThis.SciHubDoi;

  // Tier 1: metadata that identifies *this* page's article.
  const META_NAMES = [
    "citation_doi",
    "dc.identifier",
    "dc.identifier.doi",
    "dcterms.identifier",
    "prism.doi",
    "bepress_citation_doi",
    "citation_pdf_url",
    "citation_fulltext_html_url",
    "citation_abstract_html_url",
    "og:url"
  ];

  const JSONLD_KEYS = ["doi", "DOI", "identifier", "@id", "sameAs", "url", "mainEntityOfPage"];

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TEMPLATE", "SVG"]);
  const MAX_TEXT_NODES = 50000;

  // Titles for the selection window on list pages.
  const TITLE_SELECTORS = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "[itemprop='name']",
    "[itemprop='headline']",
    "[class*='title' i]",
    "[class*='heading' i]"
  ].join(", ");
  const MAX_CONTAINER_DEPTH = 6;
  const MAX_CONTAINER_TEXT = 4000;
  const MIN_LINK_TITLE = 20;
  const MIN_TITLE = 8;
  const MAX_TITLE = 300;
  const MAX_PLAIN_ITEM_TEXT = 600;

  function metaDois() {
    const out = [];
    for (const name of META_NAMES) {
      const nodes = document.querySelectorAll(
        'meta[name="' + name + '" i], meta[property="' + name + '" i]'
      );
      for (const el of nodes) {
        const doi = D.extractDoi(el.getAttribute("content"));
        D.pushUnique(out, doi);
      }
    }
    return out;
  }

  function walkJsonLd(value, out, depth) {
    if (depth > 6 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const v of value) walkJsonLd(v, out, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const key of JSONLD_KEYS) {
      const v = value[key];
      if (typeof v === "string") {
        const doi = D.extractDoi(v);
        D.pushUnique(out, doi);
      } else if (v && typeof v === "object") {
        walkJsonLd(v, out, depth + 1);
      }
    }
    for (const key of ["@graph", "mainEntity", "isPartOf", "citation"]) {
      if (value[key]) walkJsonLd(value[key], out, depth + 1);
    }
  }

  function jsonLdDois() {
    const out = [];
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        walkJsonLd(JSON.parse(el.textContent), out, 0);
      } catch (e) {
        // Malformed JSON-LD: fall back to a plain text scan of the block.
        for (const doi of D.extractAllDois(el.textContent)) {
          D.pushUnique(out, doi);
        }
      }
    }
    return out;
  }

  function urlDois() {
    const out = [];
    const canonical = document.querySelector('link[rel="canonical"][href]');
    const sources = [canonical && canonical.href, location.href];
    for (const src of sources) {
      const doi = src && D.extractDoiFromUrl(src);
      D.pushUnique(out, doi);
    }
    return out;
  }

  /** Adds `doi` to `out` and remembers the first element that mentions it. */
  function remember(out, anchors, doi, el) {
    if (!doi) return;
    D.pushUnique(out, doi);
    const key = doi.toLowerCase();
    if (el && !anchors.has(key)) anchors.set(key, el);
  }

  function linkDois(out, anchors) {
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      if (href.indexOf("10.") === -1 && !/doi/i.test(href)) continue;
      remember(out, anchors, D.extractDoiFromUrl(a.href), a);
    }
  }

  function textDois(out, anchors) {
    const rootNode = document.body || document.documentElement;
    if (!rootNode) return;
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentNode;
        if (!parent || SKIP_TAGS.has(parent.nodeName.toUpperCase())) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.indexOf("10.") !== -1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let node;
    let visited = 0;
    while ((node = walker.nextNode()) && visited++ < MAX_TEXT_NODES) {
      for (const doi of D.extractAllDois(node.nodeValue)) {
        remember(out, anchors, doi, node.parentElement);
      }
    }
  }

  /* ---------- titles (list pages) ---------- */

  function distinctDoiCount(el) {
    const found = [];
    for (const doi of D.extractAllDois(el.textContent || "")) {
      D.pushUnique(found, doi);
      if (found.length > 1) return found.length;
    }
    for (const a of el.querySelectorAll("a[href]")) {
      if ((a.getAttribute("href") || "").indexOf("10.") === -1) continue;
      D.pushUnique(found, D.extractDoiFromUrl(a.href));
      if (found.length > 1) return found.length;
    }
    return found.length;
  }

  /** The list item around `anchor`: the largest ancestor that mentions only this DOI. */
  function containerFor(anchor) {
    let el = anchor;
    for (let depth = 0; depth < MAX_CONTAINER_DEPTH; depth++) {
      const parent = el.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if ((parent.textContent || "").length > MAX_CONTAINER_TEXT) break;
      if (distinctDoiCount(parent) > 1) break;
      el = parent;
    }
    return el;
  }

  function truncate(title) {
    if (title.length <= MAX_TITLE) return title;
    return title.slice(0, MAX_TITLE).replace(/\s+\S*$/, "") + "…";
  }

  /** Best-effort article title for a DOI found at `anchor`; "" if none. */
  function titleFor(anchor, doi) {
    if (!anchor) return "";
    // 1. The DOI link's own text when it reads like a title
    //    (e.g. <a href="/doi/10.…">Article title</a>).
    if (anchor.matches("a") && !anchor.querySelector(TITLE_SELECTORS)) {
      const title = D.cleanTitle(anchor.textContent, doi);
      if (title.length >= MIN_LINK_TITLE && title.length <= MAX_TITLE) return title;
    }
    const container = containerFor(anchor);
    // 2. A heading or title-like element in the list item.
    for (const el of container.querySelectorAll(TITLE_SELECTORS)) {
      const title = D.cleanTitle(el.textContent, doi);
      if (title.length >= MIN_TITLE) return truncate(title);
    }
    // 3. Another link in the list item with title-like text.
    for (const a of container.querySelectorAll("a")) {
      const title = D.cleanTitle(a.textContent, doi);
      if (title.length >= MIN_LINK_TITLE && title.length <= MAX_TITLE) return title;
    }
    // 4. A short plain-text item, e.g. a reference-list entry: its own text.
    const text = container.textContent || "";
    if (text.length <= MAX_PLAIN_ITEM_TEXT) {
      const title = D.cleanTitle(text, doi);
      if (title.length >= MIN_TITLE) return truncate(title);
    }
    return "";
  }

  /**
   * Returns { primary, all, source } and, with options.withTitles,
   * items: [{ doi, title }]. `primary` is null on list pages (several DOIs in
   * links/text and none in metadata or the URL).
   */
  function findDois(options) {
    const metadata = [];
    for (const doi of metaDois().concat(jsonLdDois())) D.pushUnique(metadata, doi);
    const fromUrl = urlDois();
    const onPage = [];
    const anchors = new Map(); // lower-cased DOI -> first element mentioning it
    linkDois(onPage, anchors);
    textDois(onPage, anchors);

    const { primary, source } = D.choosePrimaryDoi(metadata, fromUrl, onPage);
    const all = [];
    for (const doi of [].concat(metadata, fromUrl, onPage)) D.pushUnique(all, doi);

    const result = { primary, all, source };
    if (options && options.withTitles) {
      // Links are scanned before text, so restore page order for the list.
      const anchorOf = (doi) => anchors.get(doi.toLowerCase());
      const ordered = all.slice().sort((a, b) => {
        const ea = anchorOf(a);
        const eb = anchorOf(b);
        if (!ea || !eb) return (ea ? 1 : 0) - (eb ? 1 : 0);
        return ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      result.items = ordered.map((doi) => ({ doi, title: titleFor(anchorOf(doi), doi) }));
    }
    return result;
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "getDoi") {
      return Promise.resolve(findDois({ withTitles: !!msg.withTitles }));
    }
    return undefined;
  });

  // Sci-Hub fallback tab: once the article page shows an embedded PDF
  // (e.g. after the user passed the anti-robot check), tell the background
  // page so it can jump straight to the PDF.
  const H = globalThis.SciHub;
  let pdfReported = false;
  function reportSciHubPdf() {
    if (pdfReported || !H) return;
    let url = null;
    try {
      url = H.findPdfInDocument(document);
    } catch (e) {
      return;
    }
    if (!url) return;
    pdfReported = true;
    browser.runtime.sendMessage({ type: "scihubPdf", url }).catch(() => {});
  }

  // Badge support: report the page DOI to the background page.
  let lastReported;
  function report() {
    reportSciHubPdf();
    let result;
    try {
      result = findDois();
    } catch (e) {
      return;
    }
    if (result.primary === lastReported) return;
    lastReported = result.primary;
    browser.runtime.sendMessage({ type: "doiFound", doi: result.primary }).catch(() => {});
  }

  report();
  // Late-rendered content (client-side frameworks).
  setTimeout(report, 3000);
  // Single-page-app navigation: re-scan when the URL changes.
  let lastHref = location.href;
  window.addEventListener("popstate", () => setTimeout(report, 500));
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(report, 800);
    }
  }, 1500);
})();
